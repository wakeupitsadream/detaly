// Provider round trips shared by the payments queue and reconciliation (decisions Б3, Б7, Б11):
// re-reading a payment, repeating a lost POST /payments with the same Idempotence-Key, creating
// or re-reading a refund and recording a refund the provider rejected. The provider answer is
// the only truth; the engine (@detaly/orders) applies it under the order row lock.
import { eq, payments, refunds } from '@detaly/db';
import type { OrderEvent } from '@detaly/domain';
import {
  applyPaymentObject,
  applyRefundObject,
  applyTransition,
  loadOrderSnapshot,
  recordJournalEvent,
  recordPaymentCreated,
  recordPaymentRejected,
  type PaymentRow,
  type ProviderObjectSource,
  type RefundRow,
  SUPERSEDED_REASON,
} from '@detaly/orders';
import type {
  CreatePaymentRequest,
  CreateRefundRequest,
  PaymentProvider,
  ProviderRefund,
} from '@detaly/payments';
import { UnrecoverableError } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import {
  classifyProviderError,
  enqueueStaffNotify,
  failureText,
  isRejection,
  nudgeOutbox,
  type ProviderFailure,
  requirePayments,
  YOOKASSA_ACTOR,
} from './shared';

/**
 * VERIFY: Ю17 — how long YooKassa keeps an Idempotence-Key (24 hours in the API reference). A
 * lost POST older than that is never repeated: the same key would create a second payment.
 */
export const IDEMPOTENCE_KEY_TTL_MS = 24 * 60 * 60 * 1000;

const PENDING: readonly string[] = ['pending', 'waiting_for_capture'];

export function isPendingPayment(row: Pick<PaymentRow, 'status'>): boolean {
  return PENDING.includes(row.status);
}

/** A QR row we closed because an older QR was paid: the provider may still settle it. */
export function isSupersededPayment(
  row: Pick<PaymentRow, 'status' | 'cancellationReason'>,
): boolean {
  return row.status === 'canceled' && row.cancellationReason === SUPERSEDED_REASON;
}

export async function loadPaymentRow(
  deps: Pick<WorkerDeps, 'db'>,
  id: string,
): Promise<PaymentRow | null> {
  const [row] = await deps.db.select().from(payments).where(eq(payments.id, id));
  return row ?? null;
}

export async function loadRefundRow(
  deps: Pick<WorkerDeps, 'db'>,
  id: string,
): Promise<RefundRow | null> {
  const [row] = await deps.db.select().from(refunds).where(eq(refunds.id, id));
  return row ?? null;
}

/**
 * Calls the provider; a retryable failure is rethrown (the queue retries, reconciliation logs
 * it), a final one is returned for the caller to record. Other errors propagate.
 */
async function call<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; failure: ProviderFailure }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const failure = classifyProviderError(error);
    if (failure === null || failure.kind === 'retry') throw error;
    return { ok: false, failure };
  }
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

export type PaymentCheckOutcome =
  | { outcome: 'applied'; result: string; providerStatus: string }
  | { outcome: 'created'; providerStatus: string }
  | { outcome: 'rejected'; error: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; error: string };

/**
 * GET /payments/{id} → applyPaymentObject. Without a provider id the lost POST is repeated
 * (repeatPaymentPost). Settled rows are left alone (Б3).
 */
export async function recheckPayment(
  deps: WorkerDeps,
  row: PaymentRow,
  source: ProviderObjectSource,
): Promise<PaymentCheckOutcome> {
  const superseded = isSupersededPayment(row);
  if (!isPendingPayment(row) && !superseded) return { outcome: 'skipped', reason: 'settled' };
  const provider = requirePayments(deps);
  if (row.providerPaymentId === null) {
    if (superseded) return { outcome: 'skipped', reason: 'superseded' };
    return repeatPaymentPost(deps, provider, row);
  }
  const providerPaymentId = row.providerPaymentId;
  const answer = await call(() => provider.getPayment(providerPaymentId));
  if (!answer.ok) return { outcome: 'failed', error: failureText(answer.failure) };
  const applied = await applyPaymentObject(deps.engine, answer.value, { source });
  return { outcome: 'applied', result: applied.result, providerStatus: answer.value.status };
}

/** Why a pending row without provider id is not (or no longer) worth a repeated POST. */
async function repeatBlocker(deps: WorkerDeps, row: PaymentRow): Promise<string | null> {
  if (row.request === null) return 'no_request';
  if (deps.now().getTime() - row.createdAt.getTime() >= IDEMPOTENCE_KEY_TTL_MS) {
    return 'idempotence_key_expired';
  }
  const snapshot = await loadOrderSnapshot(deps.db, row.orderId, { lock: false });
  if (snapshot === null) return 'order_not_found';
  const expected = row.kind === 'full' ? 'awaiting_handover_payment' : 'awaiting_payment';
  if (snapshot.order.status !== expected) return 'order_status';
  if (snapshot.payments.at(-1)?.id !== row.id) return 'superseded';
  return null;
}

/**
 * Decision Б7: the provider may have created the payment while our process died before
 * recordPaymentCreated. The stored body is repeated with the same Idempotence-Key: YooKassa
 * answers with the payment it already has (or creates it now), and the answer is recorded.
 * Only for the current payment of an order that still waits for it. A final rejection (4xx)
 * proves no payment exists: the row is closed (recordPaymentRejected), so the order's TTL ends
 * it and the next attempt takes a new row and key instead of repeating a refused body for a day.
 */
export async function repeatPaymentPost(
  deps: WorkerDeps,
  provider: PaymentProvider,
  row: PaymentRow,
): Promise<PaymentCheckOutcome> {
  const blocker = await repeatBlocker(deps, row);
  if (blocker !== null) return { outcome: 'skipped', reason: blocker };
  const request = row.request as CreatePaymentRequest;
  const answer = await call(() => provider.createPayment(request));
  if (!answer.ok) {
    const error = failureText(answer.failure);
    if (isRejection(answer.failure)) {
      await recordPaymentRejected(deps.engine, row.id, error);
      return { outcome: 'rejected', error };
    }
    return { outcome: 'failed', error };
  }
  await recordPaymentCreated(deps.engine, row.id, answer.value);
  return { outcome: 'created', providerStatus: answer.value.status };
}

// ---------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------

export type RefundOutcome =
  | { outcome: 'applied'; result: string; providerStatus: string }
  | { outcome: 'rejected'; error: string }
  | { outcome: 'skipped'; reason: string };

/**
 * POST /refunds with the stored body and the refund's own Idempotence-Key (Б7), or GET when the
 * provider id is known; the answer goes to applyRefundObject. A final rejection (4xx) marks the
 * refund failed with refund_failed / partial_refund_failed and the owner alert.
 */
export async function submitRefund(
  deps: WorkerDeps,
  refundId: string,
  source: ProviderObjectSource,
): Promise<RefundOutcome> {
  const row = await loadRefundRow(deps, refundId);
  if (row === null) return { outcome: 'skipped', reason: 'not_found' };
  if (row.status !== 'pending') return { outcome: 'skipped', reason: 'settled' };
  const provider = requirePayments(deps);

  let refund: ProviderRefund;
  if (row.providerRefundId !== null) {
    const providerRefundId = row.providerRefundId;
    const answer = await call(() => provider.getRefund(providerRefundId));
    if (!answer.ok) {
      // A known refund id the provider does not know: nothing to repeat safely, tell the owner.
      throw new UnrecoverableError(`refund lookup failed: ${failureText(answer.failure)}`);
    }
    refund = answer.value;
  } else {
    if (row.request === null) {
      throw new UnrecoverableError('refund has no stored request');
    }
    if (deps.now().getTime() - row.createdAt.getTime() >= IDEMPOTENCE_KEY_TTL_MS) {
      // The key may have expired at the provider: a repeated POST of a refund whose first
      // answer was lost would refund the money twice. The owner checks the account by hand.
      return { outcome: 'skipped', reason: 'idempotence_key_expired' };
    }
    const request = row.request as CreateRefundRequest;
    const answer = await call(() => provider.createRefund(request));
    if (!answer.ok) {
      const error = failureText(answer.failure);
      if (!isRejection(answer.failure)) {
        // An unreadable answer: the refund may exist. Never written off — the row stays pending
        // and the sweep repeats the POST with the same key.
        throw new UnrecoverableError(`refund answer unreadable: ${error}`);
      }
      await rejectRefund(deps, row.id, error);
      return { outcome: 'rejected', error };
    }
    refund = answer.value;
    await bindProviderRefundId(deps, row, refund.id);
  }
  const applied = await applyRefundObject(deps.engine, refund, { source });
  return { outcome: 'applied', result: applied.result, providerStatus: refund.status };
}

/**
 * Records the provider refund id on our row before the object is applied: applyRefundObject
 * matches rows without an id by payment and amount, which is ambiguous for two refunds of the
 * same amount (two items at the same price).
 */
async function bindProviderRefundId(
  deps: WorkerDeps,
  row: RefundRow,
  providerRefundId: string,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await loadOrderSnapshot(tx, row.orderId, { lock: true });
    const [current] = await tx.select().from(refunds).where(eq(refunds.id, row.id));
    if (current === undefined || current.providerRefundId !== null) return;
    await tx
      .update(refunds)
      .set({ providerRefundId, updatedAt: deps.now() })
      .where(eq(refunds.id, row.id));
  });
}

/**
 * The provider finally rejected POST /refunds (no refund object exists): refunds.status =
 * 'failed', the matching failure event (refund_failed for the whole order, partial_refund_failed
 * for an item) or, for an orphan refund, the journal and the owner alert. The 10-day clock keeps
 * running (PLAN section 2); the owner refunds by hand.
 */
export async function rejectRefund(
  deps: WorkerDeps,
  refundId: string,
  error: string,
): Promise<void> {
  const changed = await deps.db.transaction(async (tx) => {
    const [found] = await tx.select().from(refunds).where(eq(refunds.id, refundId));
    if (found === undefined) return false;
    await loadOrderSnapshot(tx, found.orderId, { lock: true });
    const [row] = await tx.select().from(refunds).where(eq(refunds.id, refundId));
    if (row === undefined || row.status !== 'pending') return false;
    const at = deps.now();
    await tx
      .update(refunds)
      .set({ status: 'failed', error, alertedAt: at, updatedAt: at })
      .where(eq(refunds.id, row.id));
    const payload = { refundId: row.id, paymentId: row.paymentId, status: 'failed', code: error };

    if (row.scope !== 'orphan') {
      const event: OrderEvent = row.scope === 'order' ? 'refund_failed' : 'partial_refund_failed';
      const transition = await applyTransition(deps.engine, {
        orderId: row.orderId,
        event,
        actor: YOOKASSA_ACTOR,
        facts: { refundId: row.id, refundConfirmed: false },
        payload: { refundId: row.id, amountKop: row.amountKop, code: error },
        tx,
      });
      // The rule notifies the owner (staff_refund_failed).
      if (transition.ok) return true;
    }
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId: row.orderId,
      type: row.scope === 'orphan' ? 'orphan_payment' : 'payment_status',
      actor: YOOKASSA_ACTOR,
      payload: row.scope === 'orphan' ? payload : { ...payload, note: 'no_transition' },
      at,
    });
    await enqueueStaffNotify(tx, {
      orderId: row.orderId,
      orderEventId,
      audience: 'owner',
      template: 'staff_refund_failed',
    });
    return true;
  });
  if (changed) nudgeOutbox(deps);
}
