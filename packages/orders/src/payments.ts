/**
 * Money in and out (docs/phase-1b-implementation.md section 5.1, decisions Б5–Б11, Б22, Б23):
 * preparing a payment, recording POST /payments answers, and applying payment, refund and
 * receipt objects re-read from the provider (never a webhook body). Every function locks the
 * order row first; webhook_events.processed_at/result are written in the same transaction.
 */
import {
  and,
  eq,
  isNull,
  payments,
  receipts,
  refunds,
  webhookEvents,
  type Executor,
} from '@detaly/db';
import type { OrderEvent, PaymentStatus, ReceiptStatus, WebhookResult } from '@detaly/domain';
import type { ProviderReceipt, ProviderRefund } from '@detaly/payments';
import { heldPayments, planItemChanges } from './context';
import { applyTransitionInTx, clock, nudge, writeItemChanges } from './engine';
import { enqueueNotify, enqueueOutbox, recordJournalEvent } from './journal';
import {
  createPaymentRows,
  createRefund,
  createRefundTask,
  EngineError,
  paymentsEnabled,
} from './rows';
import { isUuid, loadOrderSnapshot } from './snapshot';
import type {
  ActorRef,
  ApplyResult,
  EngineDeps,
  OrderSnapshot,
  PaymentRow,
  PreparePaymentResult,
  ProviderObjectSource,
  ProviderPaymentLike,
  ReceiptAttemptError,
  RefundRow,
  Tx,
} from './types';

const YOOKASSA = 'yookassa';

function providerActor(source: ProviderObjectSource): ActorRef {
  return { type: source === 'webhook' ? 'webhook' : 'system', id: YOOKASSA };
}

async function markWebhook(
  tx: Tx,
  webhookEventId: string | null | undefined,
  result: WebhookResult,
  at: Date,
): Promise<void> {
  if (!isUuid(webhookEventId)) return;
  await tx
    .update(webhookEvents)
    .set({ processedAt: at, result })
    .where(eq(webhookEvents.id, webhookEventId));
}

async function lockOrder(tx: Tx, orderId: string): Promise<OrderSnapshot> {
  const snapshot = await loadOrderSnapshot(tx, orderId, { lock: true });
  if (snapshot === null) throw new Error(`order ${orderId} not found`);
  return snapshot;
}

// ---------------------------------------------------------------------------------------------
// Preparing and recording a payment
// ---------------------------------------------------------------------------------------------

const PENDING_PAYMENT: readonly PaymentStatus[] = ['pending', 'waiting_for_capture'];

/**
 * payments.cancellation_reason of a QR row we closed ourselves because an older QR of the order
 * was paid. The provider still has it pending: a later provider answer is applied as usual.
 */
export const SUPERSEDED_REASON = 'superseded';

/** payments.cancellation_reason prefix of a POST /payments the provider refused (4xx). */
export const REJECTED_REASON_PREFIX = 'rejected:';

/** A row closed by us, not by the provider (superseded QR): its provider outcome still counts. */
function closedLocally(row: Pick<PaymentRow, 'status' | 'cancellationReason'>): boolean {
  return row.status === 'canceled' && row.cancellationReason === SUPERSEDED_REASON;
}

/**
 * Under the lock: awaiting_payment (prepayment) or awaiting_handover_payment (full); reuses a
 * live pending payment, repeats a pending one without provider id, or writes new payments and
 * receipts rows (decisions Б5–Б7).
 */
export async function preparePayment(
  deps: EngineDeps,
  input: {
    orderId: string;
    kind: 'prepayment' | 'full';
    confirmation: 'redirect' | 'qr';
    returnUrl: string;
    tx?: Tx;
  },
): Promise<PreparePaymentResult> {
  const run = async (tx: Tx): Promise<PreparePaymentResult> => {
    if (!paymentsEnabled(deps.env)) return { kind: 'unavailable', reason: 'payments_disabled' };
    const snapshot = await loadOrderSnapshot(tx, input.orderId, { lock: true });
    if (snapshot === null) return { kind: 'unavailable', reason: 'not_found' };
    const { order } = snapshot;
    const expected = input.kind === 'prepayment' ? 'awaiting_payment' : 'awaiting_handover_payment';
    const scheme = input.kind === 'prepayment' ? 'prepay' : 'pay_on_handover';
    if (order.status !== expected || order.paymentScheme !== scheme) {
      return { kind: 'unavailable', reason: 'wrong_status' };
    }
    const now = clock(deps);
    const last = snapshot.payments.at(-1);
    if (last !== undefined && last.status === 'succeeded') {
      return { kind: 'unavailable', reason: 'already_paid' };
    }
    if (last !== undefined && last.kind === input.kind && PENDING_PAYMENT.includes(last.status)) {
      const link = input.confirmation === 'qr' ? last.confirmationData : last.confirmationUrl;
      const alive = last.expiresAt === null || last.expiresAt.getTime() > now.getTime();
      if (last.providerPaymentId !== null && link !== null && alive) {
        return { kind: 'reuse', confirmationUrl: link };
      }
      if (last.providerPaymentId === null && last.request !== null) {
        // Б7: the provider may have created it already; the same key and body are repeated.
        return {
          kind: 'create',
          paymentRowId: last.id,
          request: last.request as PreparePaymentResultCreate['request'],
        };
      }
    }
    try {
      const created = await createPaymentRows(tx, snapshot, {
        kind: input.kind,
        confirmation: input.confirmation,
        returnUrl: input.returnUrl,
        env: deps.env,
      });
      return { kind: 'create', paymentRowId: created.paymentRowId, request: created.request };
    } catch (error) {
      if (error instanceof EngineError) return { kind: 'unavailable', reason: error.code };
      throw error;
    }
  };
  if (input.tx) return run(input.tx);
  return deps.db.transaction(run);
}

type PreparePaymentResultCreate = Extract<PreparePaymentResult, { kind: 'create' }>;

/** Stores the provider answer of POST /payments; journal `payment_created`. */
export async function recordPaymentCreated(
  deps: EngineDeps,
  paymentRowId: string,
  providerPayment: ProviderPaymentLike,
): Promise<void> {
  const p = providerPayment;
  const final = await deps.db.transaction(async (tx) => {
    const row = await paymentById(tx, paymentRowId);
    if (row === null) throw new Error(`payment ${paymentRowId} not found`);
    await lockOrder(tx, row.orderId);
    const current = (await paymentById(tx, paymentRowId)) as PaymentRow;
    if (current.providerPaymentId !== null && current.providerPaymentId !== p.id) {
      throw new EngineError(
        'provider_id_mismatch',
        'the payment row already has another provider payment id',
      );
    }
    const at = clock(deps);
    await tx
      .update(payments)
      .set({
        providerPaymentId: p.id,
        confirmationUrl: p.confirmationUrl ?? current.confirmationUrl,
        confirmationData: p.confirmationData ?? current.confirmationData,
        confirmationType:
          current.confirmationType ?? (p.confirmationData !== null ? 'qr' : 'redirect'),
        expiresAt: p.expiresAt ? new Date(p.expiresAt) : current.expiresAt,
        method: p.method ?? current.method,
        raw: p.raw,
        // Final statuses are applied by applyPaymentObject (transitions), never here; a row
        // closed meanwhile (superseded QR) stays closed.
        ...(PENDING_PAYMENT.includes(p.status) && PENDING_PAYMENT.includes(current.status)
          ? { status: p.status }
          : {}),
        updatedAt: at,
      })
      .where(eq(payments.id, current.id));
    if (current.providerPaymentId === null) {
      await recordJournalEvent(tx, {
        orderId: current.orderId,
        type: 'payment_created',
        actor: { type: 'system', id: YOOKASSA },
        payload: {
          paymentId: current.id,
          providerPaymentId: p.id,
          kind: current.kind,
          confirmationType: current.confirmationType,
        },
        at,
      });
    }
    return p.status === 'succeeded' || p.status === 'canceled';
  });
  if (final) await applyPaymentObject(deps, p, { source: 'web' });
}

/**
 * The provider finally refused POST /payments (HTTP 4xx, or the request was refused before it was
 * sent): no payment object exists, so the row can never be paid and is closed as canceled with
 * `rejected:<code>`. The order keeps its status: the TTL of awaiting_payment (latest payment
 * canceled) or of the QR ends it, and the next «Оплатить» / «Выставить оплату» takes a new row
 * with a new Idempotence-Key. The owner is alerted once per order (staff_payment_rejected).
 * Returns false when the row is not a pending row without a provider id any more.
 */
export async function recordPaymentRejected(
  deps: EngineDeps,
  paymentRowId: string,
  code: string,
): Promise<boolean> {
  const changed = await deps.db.transaction(async (tx) => {
    const found = await paymentById(tx, paymentRowId);
    if (found === null) return false;
    const snapshot = await lockOrder(tx, found.orderId);
    const row = (await paymentById(tx, paymentRowId)) as PaymentRow;
    if (!PENDING_PAYMENT.includes(row.status) || row.providerPaymentId !== null) return false;
    const at = clock(deps);
    const reason = `${REJECTED_REASON_PREFIX}${code}`.slice(0, 200);
    await tx
      .update(payments)
      .set({ status: 'canceled', canceledAt: at, cancellationReason: reason, updatedAt: at })
      .where(eq(payments.id, row.id));
    // The receipt that was to go inside the payment was never sent.
    await tx
      .update(receipts)
      .set({ status: 'canceled', error: 'payment rejected', updatedAt: at })
      .where(and(eq(receipts.paymentId, row.id), eq(receipts.status, 'pending')));
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId: row.orderId,
      type: 'payment_status',
      actor: { type: 'system', id: YOOKASSA },
      payload: { paymentId: row.id, status: 'canceled', note: 'rejected', code },
      at,
    });
    const alerted = snapshot.payments.some(
      (p) => p.id !== row.id && (p.cancellationReason ?? '').startsWith(REJECTED_REASON_PREFIX),
    );
    if (!alerted) {
      await enqueueOutbox(tx, {
        queue: 'notify',
        name: 'order',
        key: `notify:${orderEventId}:staff_payment_rejected`,
        data: {
          orderId: row.orderId,
          orderEventId,
          audience: 'owner',
          template: 'staff_payment_rejected',
          note: `Ответ ЮKassa: ${code}.`,
        },
      });
    }
    return true;
  });
  if (changed) nudge(deps);
  return changed;
}

async function paymentById(tx: Executor, id: string): Promise<PaymentRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await tx.select().from(payments).where(eq(payments.id, id));
  return row ?? null;
}

async function findPaymentRow(tx: Tx, p: ProviderPaymentLike): Promise<PaymentRow | null> {
  const [byProvider] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.provider, YOOKASSA), eq(payments.providerPaymentId, p.id)));
  if (byProvider) return byProvider;
  // The provider id may not be recorded yet (crash between the answer and the write, Б7).
  const rowId = p.metadata?.payment_row_id;
  const row = isUuid(rowId) ? await paymentById(tx, rowId) : null;
  if (row !== null && (row.providerPaymentId === null || row.providerPaymentId === p.id)) {
    return row;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Payment objects
// ---------------------------------------------------------------------------------------------

/** Applies a payment object re-read from the provider (never a webhook body). */
export async function applyPaymentObject(
  deps: EngineDeps,
  providerPayment: ProviderPaymentLike,
  options: { source: ProviderObjectSource; webhookEventId?: string | null },
): Promise<{ result: WebhookResult; transition?: ApplyResult }> {
  const p = providerPayment;
  const outcome = await deps.db.transaction(async (tx) => {
    const at = clock(deps);
    const found = await findPaymentRow(tx, p);
    if (found === null) {
      await markWebhook(tx, options.webhookEventId, 'ignored', at);
      return { result: 'ignored' as WebhookResult };
    }
    await lockOrder(tx, found.orderId);
    const row = (await paymentById(tx, found.id)) as PaymentRow;
    const prev = row.status;
    const next = p.status;
    // A QR we closed ourselves (superseded) is still alive at the provider: its outcome counts.
    const local = closedLocally(row);
    const settled = prev === 'succeeded' || (prev === 'canceled' && !local);
    const keepStatus = settled || (local && PENDING_PAYMENT.includes(next));

    await tx
      .update(payments)
      .set({
        providerPaymentId: row.providerPaymentId ?? p.id,
        method: p.method ?? row.method,
        confirmationUrl: row.confirmationUrl ?? p.confirmationUrl,
        confirmationData: row.confirmationData ?? p.confirmationData,
        raw: p.raw,
        ...(keepStatus
          ? {}
          : {
              status: next,
              ...(next === 'succeeded' ? { paidAt: p.paidAt ? new Date(p.paidAt) : at } : {}),
              ...(next === 'canceled'
                ? { canceledAt: at, cancellationReason: p.cancellationReason ?? null }
                : {}),
            }),
        updatedAt: at,
      })
      .where(eq(payments.id, row.id));

    let out: { result: WebhookResult; transition?: ApplyResult };
    if (next === 'pending' || next === 'waiting_for_capture') {
      out = { result: 'pending' };
    } else if (prev === next) {
      out = { result: 'duplicate' };
    } else if (settled) {
      // A settled payment never changes its outcome; keep the evidence for the owner.
      await recordJournalEvent(tx, {
        orderId: row.orderId,
        type: 'payment_status',
        actor: providerActor(options.source),
        payload: { paymentId: row.id, status: next, previous: prev, note: 'status_flip' },
        at,
      });
      out = { result: 'error' };
    } else if (next === 'succeeded') {
      out = await onPaymentSucceeded(tx, deps, row, p, options.source, at);
    } else {
      out = await onPaymentCanceled(tx, deps, row, options.source, at);
    }
    await markWebhook(tx, options.webhookEventId, out.result, at);
    return out;
  });
  nudge(deps);
  return outcome;
}

async function onPaymentSucceeded(
  tx: Tx,
  deps: EngineDeps,
  row: PaymentRow,
  p: ProviderPaymentLike,
  source: ProviderObjectSource,
  at: Date,
): Promise<{ result: WebhookResult; transition?: ApplyResult }> {
  const actor = providerActor(source);
  const snapshot = await lockOrder(tx, row.orderId);
  // The receipt sent inside the payment: its status is polled by receipts/payment-receipt (Б23).
  for (const receipt of snapshot.receipts) {
    if (
      receipt.paymentId === row.id &&
      (receipt.kind === 'prepayment' || receipt.kind === 'full')
    ) {
      await enqueueOutbox(tx, {
        queue: 'receipts',
        name: 'payment-receipt',
        key: `payment-receipt:${receipt.id}`,
        data: { receiptId: receipt.id, orderId: row.orderId },
      });
    }
  }

  if (snapshot.order.status === 'refunded' || snapshot.order.status === 'refund_pending') {
    // Б11: a payment of an order whose money is (being) returned goes back whole; the status
    // stays and the refund carries the 10-day deadline like any other.
    let refund: { refundId: string; amountKop: number } | null = null;
    let refundError: string | null = null;
    try {
      refund = await tx.transaction((sp) =>
        createRefund(sp, snapshot, {
          scope: 'orphan',
          paymentId: row.id,
          reason: 'late_payment',
          requestedAt: at,
          actor,
          env: deps.env,
        }),
      );
    } catch (error) {
      refundError = error instanceof Error ? error.name : 'error';
    }
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId: row.orderId,
      type: 'orphan_payment',
      actor,
      payload: {
        paymentId: row.id,
        amountKop: p.amountKop,
        refundId: refund?.refundId ?? null,
        ...(refundError ? { refundError } : {}),
      },
      at,
    });
    await enqueueNotify(tx, {
      orderId: row.orderId,
      orderEventId,
      audience: 'owner',
      template: 'staff_orphan_payment',
    });
    return { result: 'orphan_payment' };
  }

  // A payment in another currency never matches the total (VERIFY: Ю11 — RUB only).
  const currencyOk = p.currency === undefined || p.currency === null || p.currency === 'RUB';
  const paidAmountKop = currencyOk ? p.amountKop : -1;
  const transition = await applyTransitionInTx(
    tx,
    deps,
    {
      orderId: row.orderId,
      event: 'payment_succeeded',
      actor,
      facts: { paidAmountKop, paymentId: row.id, providerPaymentStatus: 'succeeded' },
      payload: { source },
    },
    { snapshot },
  );
  if (transition.ok) {
    if (transition.to === 'awaiting_handover_payment' && row.kind === 'full') {
      await supersedeNewerQr(tx, snapshot, row, actor, at);
    }
    // A second payment (both QR of a handover paid, two tabs) or a payment after handover: the
    // order holds money it does not need. The owner decides; a refund task keeps the 10-day
    // deadline of ст. 22 in the reminders until «Вернуть платёж».
    const duplicate = heldPayments(snapshot).some((held) => held.id !== row.id);
    const afterHandover = transition.from === 'handed' || transition.from === 'completed';
    if (duplicate || afterHandover) {
      await createRefundTask(tx, snapshot, {
        paymentId: row.id,
        reason: 'other',
        requestedAt: at,
        actor,
        note: afterHandover ? 'payment_after_handover' : 'duplicate_payment',
      });
    }
    if (duplicate && !transition.rule.notify.some((spec) => spec.audience === 'owner')) {
      const { orderEventId } = await recordJournalEvent(tx, {
        orderId: row.orderId,
        type: 'payment_status',
        actor,
        payload: { paymentId: row.id, status: 'succeeded', note: 'duplicate_payment' },
        at,
      });
      await enqueueNotify(tx, {
        orderId: row.orderId,
        orderEventId,
        audience: 'owner',
        template: 'staff_unexpected_payment',
      });
    }
    return {
      result: paidAmountKop === snapshot.order.totalKop ? 'processed' : 'amount_mismatch',
      transition,
    };
  }
  // Money arrived where no rule expects it (e.g. before confirmation): the owner decides, with
  // a refund task carrying the 10-day deadline.
  await createRefundTask(tx, snapshot, {
    paymentId: row.id,
    reason: 'other',
    requestedAt: at,
    actor,
    note: 'unexpected_payment',
  });
  const { orderEventId } = await recordJournalEvent(tx, {
    orderId: row.orderId,
    type: 'payment_status',
    actor,
    payload: {
      paymentId: row.id,
      status: 'succeeded',
      note: 'no_transition',
      failed: transition.failed,
    },
    at,
  });
  await enqueueNotify(tx, {
    orderId: row.orderId,
    orderEventId,
    audience: 'owner',
    template: 'staff_unexpected_payment',
  });
  return { result: 'ignored', transition };
}

/**
 * An older QR of the order was paid while newer ones are still shown (QR expired, a new one was
 * issued, the client paid the first): the newer pending QR rows are closed as `superseded`, so
 * nothing waits for them. Their provider outcome is still applied if it ever comes.
 */
async function supersedeNewerQr(
  tx: Tx,
  snapshot: OrderSnapshot,
  paid: PaymentRow,
  actor: ActorRef,
  at: Date,
): Promise<void> {
  const index = snapshot.payments.findIndex((p) => p.id === paid.id);
  const newer = snapshot.payments
    .slice(index + 1)
    .filter((p) => p.kind === 'full' && PENDING_PAYMENT.includes(p.status));
  for (const qr of newer) {
    await tx
      .update(payments)
      .set({
        status: 'canceled',
        canceledAt: at,
        cancellationReason: SUPERSEDED_REASON,
        updatedAt: at,
      })
      .where(eq(payments.id, qr.id));
    await recordJournalEvent(tx, {
      orderId: paid.orderId,
      type: 'payment_status',
      actor,
      payload: { paymentId: qr.id, status: 'canceled', note: SUPERSEDED_REASON, paidBy: paid.id },
      at,
    });
  }
}

async function onPaymentCanceled(
  tx: Tx,
  deps: EngineDeps,
  row: PaymentRow,
  source: ProviderObjectSource,
  at: Date,
): Promise<{ result: WebhookResult; transition?: ApplyResult }> {
  const actor = providerActor(source);
  const snapshot = await lockOrder(tx, row.orderId);
  if (snapshot.payments.at(-1)?.id !== row.id) {
    await recordJournalEvent(tx, {
      orderId: row.orderId,
      type: 'webhook_stale',
      actor,
      payload: { paymentId: row.id, status: 'canceled' },
      at,
    });
    return { result: 'stale' };
  }
  const transition = await applyTransitionInTx(
    tx,
    deps,
    {
      orderId: row.orderId,
      event: 'payment_canceled',
      actor,
      facts: { paymentId: row.id, providerPaymentStatus: 'canceled' },
      payload: { source },
    },
    { snapshot },
  );
  if (!transition.ok) {
    await recordJournalEvent(tx, {
      orderId: row.orderId,
      type: 'payment_status',
      actor,
      payload: { paymentId: row.id, status: 'canceled', note: 'no_transition' },
      at,
    });
  }
  return { result: 'processed', transition };
}

// ---------------------------------------------------------------------------------------------
// Refund objects
// ---------------------------------------------------------------------------------------------

async function findRefundRow(tx: Tx, r: ProviderRefund): Promise<RefundRow | null> {
  const [byProvider] = await tx.select().from(refunds).where(eq(refunds.providerRefundId, r.id));
  if (byProvider) return byProvider;
  // The provider id may not be recorded yet: the only pending refund of that payment and amount.
  const candidates = await tx
    .select({ refund: refunds })
    .from(refunds)
    .innerJoin(payments, eq(payments.id, refunds.paymentId))
    .where(
      and(
        eq(payments.providerPaymentId, r.paymentId),
        eq(refunds.amountKop, r.amountKop),
        eq(refunds.status, 'pending'),
        isNull(refunds.providerRefundId),
      ),
    );
  return candidates.length === 1 ? (candidates[0]?.refund ?? null) : null;
}

/** receipt_registration of a refund object as received (VERIFY: Ю10 — field of the refund). */
function refundReceiptRegistration(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as { receipt_registration?: unknown }).receipt_registration;
  return typeof value === 'string' ? value : null;
}

/** Applies a refund object re-read from the provider. */
export async function applyRefundObject(
  deps: EngineDeps,
  providerRefund: ProviderRefund,
  options: { source: ProviderObjectSource; webhookEventId?: string | null },
): Promise<{ result: WebhookResult; transition?: ApplyResult }> {
  const r = providerRefund;
  const outcome = await deps.db.transaction(async (tx) => {
    const at = clock(deps);
    const actor = providerActor(options.source);
    const found = await findRefundRow(tx, r);
    if (found === null) {
      await markWebhook(tx, options.webhookEventId, 'ignored', at);
      return { result: 'ignored' as WebhookResult };
    }
    await lockOrder(tx, found.orderId);
    const [row] = await tx.select().from(refunds).where(eq(refunds.id, found.id));
    const refund = row as RefundRow;
    const next = r.status === 'canceled' ? 'failed' : r.status;
    let out: { result: WebhookResult; transition?: ApplyResult };

    if (next === 'pending') {
      if (refund.providerRefundId === null) {
        await tx
          .update(refunds)
          .set({ providerRefundId: r.id, updatedAt: at })
          .where(eq(refunds.id, refund.id));
      }
      out = { result: 'pending' };
    } else if (refund.status === next) {
      out = { result: 'duplicate' };
    } else if (refund.status !== 'pending') {
      await recordJournalEvent(tx, {
        orderId: refund.orderId,
        type: 'payment_status',
        actor,
        payload: {
          refundId: refund.id,
          status: next,
          previous: refund.status,
          note: 'status_flip',
        },
        at,
      });
      out = { result: 'error' };
    } else {
      await tx
        .update(refunds)
        .set({
          status: next,
          providerRefundId: refund.providerRefundId ?? r.id,
          ...(next === 'succeeded' ? { succeededAt: at, error: null } : { error: 'canceled' }),
          updatedAt: at,
        })
        .where(eq(refunds.id, refund.id));
      if (next === 'succeeded') {
        const registration = r.receiptRegistration ?? refundReceiptRegistration(r.raw);
        const pending = await tx
          .select({ id: receipts.id, kind: receipts.kind })
          .from(receipts)
          .where(and(eq(receipts.refundId, refund.id), eq(receipts.status, 'pending')));
        for (const receipt of pending) {
          if (registration === 'succeeded') {
            await tx
              .update(receipts)
              .set({ status: 'succeeded', updatedAt: at })
              .where(eq(receipts.id, receipt.id));
            await recordJournalEvent(tx, {
              orderId: refund.orderId,
              type: 'receipt_succeeded',
              actor,
              payload: { receiptId: receipt.id, kind: receipt.kind, refundId: refund.id },
              at,
            });
          } else {
            // The refund receipt is registered after the money moved: polled like the
            // receipt of a payment (receipts/refund-receipt), alert when it does not come.
            await enqueueOutbox(tx, {
              queue: 'receipts',
              name: 'refund-receipt',
              key: `refund-receipt:${receipt.id}`,
              data: { receiptId: receipt.id, orderId: refund.orderId },
            });
          }
        }
      }
      out = await onRefundSettled(tx, deps, refund, next, actor, at);
    }
    await markWebhook(tx, options.webhookEventId, out.result, at);
    return out;
  });
  nudge(deps);
  return outcome;
}

async function onRefundSettled(
  tx: Tx,
  deps: EngineDeps,
  refund: RefundRow,
  status: 'succeeded' | 'failed',
  actor: ActorRef,
  at: Date,
): Promise<{ result: WebhookResult; transition?: ApplyResult }> {
  const snapshot = await lockOrder(tx, refund.orderId);
  if (refund.scope === 'orphan') {
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId: refund.orderId,
      type: 'orphan_payment',
      actor,
      payload: { refundId: refund.id, paymentId: refund.paymentId, status },
      at,
    });
    if (status === 'failed') {
      await enqueueNotify(tx, {
        orderId: refund.orderId,
        orderEventId,
        audience: 'owner',
        template: 'staff_refund_failed',
      });
    }
    return { result: 'processed' };
  }
  const event: OrderEvent =
    refund.scope === 'order'
      ? status === 'succeeded'
        ? 'refund_succeeded'
        : 'refund_failed'
      : status === 'succeeded'
        ? 'partial_refund_succeeded'
        : 'partial_refund_failed';
  const transition = await applyTransitionInTx(
    tx,
    deps,
    {
      orderId: refund.orderId,
      event,
      actor,
      facts: { refundId: refund.id, refundConfirmed: status === 'succeeded' },
      payload: { refundId: refund.id, amountKop: refund.amountKop },
    },
    { snapshot },
  );
  if (transition.ok) return { result: 'processed', transition };

  // No rule for the order's status: the money still moved, so the items follow it and the
  // owner is told.
  if (status === 'succeeded') {
    const changes = planItemChanges(
      refund.scope === 'order' ? 'refund_succeeded' : 'partial_refund_succeeded',
      snapshot,
      { refundId: refund.id },
    );
    await writeItemChanges(tx, refund.orderId, changes, at);
  }
  const { orderEventId } = await recordJournalEvent(tx, {
    orderId: refund.orderId,
    type: 'payment_status',
    actor,
    payload: { refundId: refund.id, status, note: 'no_transition', failed: transition.failed },
    at,
  });
  if (status === 'failed') {
    await enqueueNotify(tx, {
      orderId: refund.orderId,
      orderEventId,
      audience: 'owner',
      template: 'staff_refund_failed',
    });
  }
  return { result: 'processed', transition };
}

// ---------------------------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------------------------

/** Receipt status from the provider; succeeded -> journal receipt_succeeded, final error -> receipt_failed. */
export async function applyReceiptObject(
  deps: EngineDeps,
  receiptRowId: string,
  result: ProviderReceipt | ReceiptAttemptError,
): Promise<{ status: ReceiptStatus; changed: boolean }> {
  if (!isUuid(receiptRowId)) throw new Error('receipt id is not a uuid');
  return deps.db.transaction(async (tx) => {
    const [found] = await tx.select().from(receipts).where(eq(receipts.id, receiptRowId));
    if (!found) throw new Error(`receipt ${receiptRowId} not found`);
    await lockOrder(tx, found.orderId);
    const [row] = await tx.select().from(receipts).where(eq(receipts.id, receiptRowId));
    const receipt = row as typeof found;
    const at = clock(deps);
    const actor: ActorRef = { type: 'system', id: YOOKASSA };
    if (receipt.status === 'succeeded') return { status: 'succeeded', changed: false };

    if ('error' in result) {
      const { code, message, final } = result.error;
      const error = `${code ?? 'error'}: ${message}`.slice(0, 500);
      if (!final) {
        await tx.update(receipts).set({ error, updatedAt: at }).where(eq(receipts.id, receipt.id));
        return { status: receipt.status, changed: false };
      }
      await tx
        .update(receipts)
        .set({ status: 'canceled', error, updatedAt: at })
        .where(eq(receipts.id, receipt.id));
      if (receipt.status !== 'canceled') {
        await recordJournalEvent(tx, {
          orderId: receipt.orderId,
          type: 'receipt_failed',
          actor,
          payload: { receiptId: receipt.id, kind: receipt.kind, code },
          at,
        });
      }
      return { status: 'canceled', changed: receipt.status !== 'canceled' };
    }

    const p = result;
    await tx
      .update(receipts)
      .set({
        providerReceiptId: receipt.providerReceiptId ?? p.id,
        status: p.status,
        fiscalDocumentNumber: p.fiscalDocumentNumber ?? receipt.fiscalDocumentNumber,
        response: p.raw,
        ...(p.status === 'succeeded' ? { error: null } : {}),
        updatedAt: at,
      })
      .where(eq(receipts.id, receipt.id));
    const changed = receipt.status !== p.status;
    if (changed && p.status === 'succeeded') {
      await recordJournalEvent(tx, {
        orderId: receipt.orderId,
        type: 'receipt_succeeded',
        actor,
        payload: { receiptId: receipt.id, kind: receipt.kind },
        at,
      });
    } else if (changed && p.status === 'canceled') {
      await recordJournalEvent(tx, {
        orderId: receipt.orderId,
        type: 'receipt_failed',
        actor,
        payload: { receiptId: receipt.id, kind: receipt.kind, code: 'canceled' },
        at,
      });
    }
    return { status: p.status, changed };
  });
}
