// housekeeping/timers, every minute (decision Б27, docs/phase-1b-implementation.md 12.2).
// The database is the source of truth: orders.expires_at by status, client_approvals.expires_at.
//
// - awaiting_payment past its deadline (expires_at; 1A orders have null there: created_at +
//   order.payment_ttl_min): no payment or a canceled one -> payment_ttl_expired; a pending
//   payment at the provider -> payments/payment-recheck only (cancel only after the provider
//   confirms, PLAN section 4); a pending row without a provider id is left to reconciliation
//   while its Idempotence-Key lives (24 h); after that no payment can come of it: it counts as
//   canceled for the TTL (the row itself stays as it is) and the owner is alerted;
// - awaiting_confirmation -> confirmation_timeout (1A: created_at + on_pickup_confirm_ttl_h);
// - awaiting_handover_payment (QR TTL) -> payment_ttl_expired (Б9);
// - ready past the storage window -> storage_expired (pickupWindowElapsed);
// - handed past handed.complete_days -> completion_timeout;
// - an open approval past expires_at (timer started by notify) -> approval_timeout.
// Every transition goes through applyTransition (row lock, guards, effects, outbox).
import { PAYMENTS_JOBS } from '@detaly/config';
import {
  and,
  asc,
  clientApprovals,
  desc,
  eq,
  isNotNull,
  isNull,
  or,
  orders,
  payments,
} from '@detaly/db';
import type { OrderEvent, OrderStatus } from '@detaly/domain';
import {
  applyTransition,
  enqueueOutbox,
  loadOrderSettings,
  loadOrderSnapshot,
  recordJournalEvent,
  type TransitionFacts,
} from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import { IDEMPOTENCE_KEY_TTL_MS } from '../payments/money';
import { refreshCard } from '../receipts/offset';
import { BATCH, HOUR_MS, HOUSEKEEPING_ACTOR, MINUTE_MS, notAfter, nudge } from './common';

/**
 * A pending payment past the TTL is rechecked at most once per this period.
 * VERIFY (docs/external.md Ю18): YooKassa cancels an unpaid pending payment by itself
 * (expired_on_confirmation); until it does, the order stays in awaiting_payment.
 */
export const PAYMENT_RECHECK_EVERY_MS = 10 * MINUTE_MS;

export interface TimersResult {
  transitions: number;
  /** payments/payment-recheck jobs queued for pending payments past the TTL. */
  rechecks: number;
  /** Due orders whose transition was refused (guard_failed / no_rule): see the log. */
  refused: number;
  errors: number;
}

/** `moved`: the status changed meanwhile (another job won the lock); not an anomaly. */
type Outcome = 'transition' | 'refused' | 'moved' | 'error';

async function fire(
  deps: WorkerDeps,
  input: { orderId: string; event: OrderEvent; facts?: TransitionFacts; expected: OrderStatus },
): Promise<Outcome> {
  try {
    const result = await applyTransition(deps.engine, {
      orderId: input.orderId,
      event: input.event,
      actor: HOUSEKEEPING_ACTOR,
      ...(input.facts ? { facts: input.facts } : {}),
      payload: { source: 'housekeeping' },
    });
    if (result.ok) {
      // A timer moves the order without a press (QR expired -> ready, no-show, ...): the open
      // sellers card is redrawn with the buttons of the new status. Best effort.
      await refreshCard(deps, { orderId: input.orderId });
      return 'transition';
    }
    if (result.status !== null && result.status !== input.expected) return 'moved';
    deps.logger.warn(
      { orderId: input.orderId, event: input.event, reason: result.reason, failed: result.failed },
      'housekeeping timer refused',
    );
    return 'refused';
  } catch (error) {
    deps.logger.error(
      { orderId: input.orderId, event: input.event, err: (error as Error).name },
      'housekeeping timer failed',
    );
    return 'error';
  }
}

/**
 * The owner learns that a payment row never got a provider payment (every POST failed for a
 * day): journal payment_status and staff_payment_rejected, once per payment row.
 */
async function alertNoProviderPayment(
  deps: WorkerDeps,
  orderId: string,
  paymentId: string,
): Promise<void> {
  try {
    await deps.db.transaction(async (tx) => {
      await loadOrderSnapshot(tx, orderId, { lock: true });
      const { orderEventId } = await recordJournalEvent(tx, {
        orderId,
        type: 'payment_status',
        actor: HOUSEKEEPING_ACTOR,
        payload: { paymentId, status: 'pending', note: 'no_provider_payment' },
        at: deps.now(),
      });
      await enqueueOutbox(tx, {
        queue: 'notify',
        name: 'order',
        key: `notify:${orderEventId}:staff_payment_rejected`,
        data: {
          orderId,
          orderEventId,
          audience: 'owner',
          template: 'staff_payment_rejected',
          note: 'Ответа ЮKassa на создание платежа не было сутки: срок оплаты закрыт.',
        },
      });
    });
    nudge(deps);
  } catch (error) {
    deps.logger.error({ orderId, err: (error as Error).name }, 'housekeeping alert failed');
  }
}

export async function runTimers(deps: WorkerDeps): Promise<TimersResult> {
  const now = deps.now();
  const settings = await loadOrderSettings(deps.db, deps.env);
  const result: TimersResult = { transitions: 0, rechecks: 0, refused: 0, errors: 0 };
  const count = (outcome: Outcome) => {
    if (outcome === 'transition') result.transitions += 1;
    else if (outcome === 'refused') result.refused += 1;
    else if (outcome === 'error') result.errors += 1;
  };

  /** Orders of `status` whose deadline passed; `fallbackMs` covers 1A rows without expires_at. */
  const due = (status: OrderStatus, fallbackMs: number | null) =>
    deps.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.status, status),
          fallbackMs === null
            ? notAfter(orders.expiresAt, now)
            : or(
                notAfter(orders.expiresAt, now),
                and(
                  isNull(orders.expiresAt),
                  notAfter(orders.createdAt, new Date(now.getTime() - fallbackMs)),
                ),
              ),
        ),
      )
      .orderBy(asc(orders.expiresAt), asc(orders.createdAt))
      .limit(BATCH);

  // 1. awaiting_payment: cancel only what the provider confirmed unpaid.
  for (const { id } of await due('awaiting_payment', settings.paymentTtlMin * MINUTE_MS)) {
    const [payment] = await deps.db
      .select({
        id: payments.id,
        status: payments.status,
        providerPaymentId: payments.providerPaymentId,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(eq(payments.orderId, id))
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(1);
    if (!payment || payment.status === 'canceled') {
      // providerPaymentStatus comes from the latest payment row: null or 'canceled'.
      count(
        await fire(deps, {
          orderId: id,
          event: 'payment_ttl_expired',
          expected: 'awaiting_payment',
        }),
      );
      continue;
    }
    if (payment.status === 'succeeded') continue; // the webhook / reconciliation applies it
    if (payment.providerPaymentId === null) {
      // Reconciliation repeats the POST while the Idempotence-Key lives; after that the POST
      // is never repeated, so no payment can come of the row: it counts as canceled.
      if (now.getTime() - payment.createdAt.getTime() < IDEMPOTENCE_KEY_TTL_MS) continue;
      const outcome = await fire(deps, {
        orderId: id,
        event: 'payment_ttl_expired',
        facts: { paymentId: payment.id, providerPaymentStatus: 'canceled' },
        expected: 'awaiting_payment',
      });
      count(outcome);
      if (outcome === 'transition') await alertNoProviderPayment(deps, id, payment.id);
      continue;
    }
    const slot = Math.floor(now.getTime() / PAYMENT_RECHECK_EVERY_MS);
    const queued = await enqueueOutbox(deps.db, {
      queue: 'payments',
      name: PAYMENTS_JOBS.paymentRecheck,
      key: `payment-recheck:${payment.id}:ttl:${slot}`,
      data: { paymentId: payment.id, orderId: id, source: 'housekeeping' },
    });
    if (queued) result.rechecks += 1;
  }

  // 2. awaiting_confirmation: 24 h without «Подтверждаю».
  for (const { id } of await due('awaiting_confirmation', settings.onPickupConfirmTtlH * HOUR_MS)) {
    count(
      await fire(deps, {
        orderId: id,
        event: 'confirmation_timeout',
        expected: 'awaiting_confirmation',
      }),
    );
  }

  // 3. awaiting_handover_payment: the QR expired (Б9: no provider confirmation needed).
  for (const { id } of await due('awaiting_handover_payment', null)) {
    count(
      await fire(deps, {
        orderId: id,
        event: 'payment_ttl_expired',
        expected: 'awaiting_handover_payment',
      }),
    );
  }

  // 4. ready: the storage window is over (no-show).
  for (const { id } of await due('ready', null)) {
    count(
      await fire(deps, {
        orderId: id,
        event: 'storage_expired',
        facts: { pickupWindowElapsed: true },
        expected: 'ready',
      }),
    );
  }

  // 5. handed: no claim within handed.complete_days.
  for (const { id } of await due('handed', null)) {
    count(await fire(deps, { orderId: id, event: 'completion_timeout', expected: 'handed' }));
  }

  // 6. client approvals whose timer (started when decision_needed was delivered) ran out.
  const approvals = await deps.db
    .select({ orderId: clientApprovals.orderId, scope: clientApprovals.scope })
    .from(clientApprovals)
    .innerJoin(orders, eq(orders.id, clientApprovals.orderId))
    .where(
      and(
        isNull(clientApprovals.decidedAt),
        isNotNull(clientApprovals.expiresAt),
        notAfter(clientApprovals.expiresAt, now),
        eq(orders.status, 'awaiting_client_approval'),
      ),
    )
    .orderBy(asc(clientApprovals.expiresAt))
    .limit(BATCH);
  for (const approval of approvals) {
    count(
      await fire(deps, {
        orderId: approval.orderId,
        event: 'approval_timeout',
        facts: { scope: approval.scope === 'item' ? 'item' : 'order' },
        expected: 'awaiting_client_approval',
      }),
    );
  }

  if (result.rechecks > 0) nudge(deps);
  return result;
}
