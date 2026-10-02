// Processor of the `payments` queue (docs/phase-1b-implementation.md section 10, decisions Б3,
// Б7, Б9, Б11): webhook, payment-create, payment-recheck, refund-create. Every job first reads
// the database row and leaves when the work is done (idempotency lives in the database, not in
// BullMQ job ids). A webhook body is never trusted: the object is re-read from the provider.
import { PAYMENTS_JOBS } from '@detaly/config';
import { and, eq, isNull, webhookEvents } from '@detaly/db';
import {
  applyPaymentObject,
  applyRefundObject,
  loadOrderSnapshot,
  recordPaymentCreated,
} from '@detaly/orders';
import type { CreatePaymentRequest } from '@detaly/payments';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import {
  isPendingPayment,
  loadPaymentRow,
  recheckPayment,
  submitRefund,
  type PaymentCheckOutcome,
  type RefundOutcome,
} from './money';
import {
  classifyProviderError,
  failureText,
  isNotFound,
  requirePayments,
  unknownJob,
  uuidField,
} from './shared';

export async function processPayments(job: Job, deps: WorkerDeps): Promise<unknown> {
  switch (job.name) {
    case PAYMENTS_JOBS.webhook:
      return processWebhook(job, deps);
    case PAYMENTS_JOBS.paymentCreate:
      return processPaymentCreate(job, deps);
    case PAYMENTS_JOBS.paymentRecheck:
      return processPaymentRecheck(job, deps);
    case PAYMENTS_JOBS.refundCreate:
      return processRefundCreate(job, deps);
    default:
      return unknownJob(deps, 'payments', job.name);
  }
}

// ---------------------------------------------------------------------------------------------
// webhook {webhookEventId}
// ---------------------------------------------------------------------------------------------

export type WebhookJobResult =
  | { skipped: 'not_found' | 'already_processed' }
  | { result: string; objectType: 'payment' | 'refund' };

/**
 * A stored YooKassa notification (webhook_events row written by the web route): the payment or
 * refund is re-read by id and applied with source 'webhook'; the engine writes
 * webhook_events.processed_at/result in the same transaction. Provider errors that may pass are
 * retried by the queue; an object the provider does not know is a forged or foreign
 * notification and is marked `ignored`.
 */
export async function processWebhook(
  job: Pick<Job, 'name' | 'data'>,
  deps: WorkerDeps,
): Promise<WebhookJobResult> {
  const id = uuidField(job, 'webhookEventId');
  const [event] = await deps.db.select().from(webhookEvents).where(eq(webhookEvents.id, id));
  if (event === undefined) {
    deps.logger.warn({ webhookEventId: id }, 'webhook event not found');
    return { skipped: 'not_found' };
  }
  if (event.processedAt !== null) return { skipped: 'already_processed' };
  if (event.source !== 'yookassa') {
    throw new UnrecoverableError(`webhook source ${event.source} is not handled here`);
  }
  const provider = requirePayments(deps);
  const objectType = event.eventType.startsWith('refund.') ? 'refund' : 'payment';
  const log = { webhookEventId: id, event: event.eventType, objectId: event.externalId };

  try {
    let result: string;
    if (objectType === 'refund') {
      const refund = await provider.getRefund(event.externalId);
      ({ result } = await applyRefundObject(deps.engine, refund, {
        source: 'webhook',
        webhookEventId: id,
      }));
    } else {
      const payment = await provider.getPayment(event.externalId);
      ({ result } = await applyPaymentObject(deps.engine, payment, {
        source: 'webhook',
        webhookEventId: id,
      }));
    }
    deps.logger.info({ ...log, result }, 'webhook applied');
    return { result, objectType };
  } catch (error) {
    const failure = classifyProviderError(error);
    if (isNotFound(failure)) {
      // The object does not exist at the provider: nothing to apply, never retried.
      await deps.db
        .update(webhookEvents)
        .set({ processedAt: deps.now(), result: 'ignored' })
        .where(and(eq(webhookEvents.id, id), isNull(webhookEvents.processedAt)));
      deps.logger.warn(log, 'webhook object not found at the provider');
      return { result: 'ignored', objectType };
    }
    if (failure !== null && failure.kind === 'final') {
      // bad_response, 401/403: a configuration problem, parked in dead-letter for the owner.
      throw new UnrecoverableError(`webhook object re-read failed: ${failureText(failure)}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// payment-create {paymentId}: the QR at the pickup point
// ---------------------------------------------------------------------------------------------

export type PaymentCreateResult =
  { skipped: string } | { providerStatus: string; qr: 'sent' | 'already_sent' | 'none' };

/** The QR photo goes to the sellers once per payment; the mark lives a day. */
const QR_SENT_TTL_SEC = 24 * 60 * 60;

function qrSentKey(deps: Pick<WorkerDeps, 'keyPrefix'>, paymentId: string): string {
  return `${deps.keyPrefix}payments:qr-sent:${paymentId}`;
}

/**
 * Payment at the pickup point (create_handover_payment wrote the payments row with its request):
 * POST /payments with the stored body and the same Idempotence-Key, recordPaymentCreated, then
 * the QR photo to the sellers chat only. Leaves when the order no longer waits for this payment.
 */
export async function processPaymentCreate(
  job: Pick<Job, 'name' | 'data'>,
  deps: WorkerDeps,
): Promise<PaymentCreateResult> {
  const paymentId = uuidField(job, 'paymentId');
  const row = await loadPaymentRow(deps, paymentId);
  if (row === null) return { skipped: 'not_found' };
  const snapshot = await loadOrderSnapshot(deps.db, row.orderId, { lock: false });
  if (snapshot === null) return { skipped: 'order_not_found' };
  if (snapshot.order.status !== 'awaiting_handover_payment') return { skipped: 'order_status' };
  if (!isPendingPayment(row)) return { skipped: 'settled' };
  if (snapshot.payments.at(-1)?.id !== row.id) return { skipped: 'superseded' };
  const log = { orderId: row.orderId, orderNumber: snapshot.order.number, paymentId };

  let current = row;
  if (row.providerPaymentId === null) {
    if (row.request === null) throw new UnrecoverableError('payment has no stored request');
    const provider = requirePayments(deps);
    const request = row.request as CreatePaymentRequest;
    let created;
    try {
      created = await provider.createPayment(request);
    } catch (error) {
      const failure = classifyProviderError(error);
      if (failure !== null && failure.kind === 'final') {
        throw new UnrecoverableError(`QR payment rejected: ${failureText(failure)}`);
      }
      throw error;
    }
    await recordPaymentCreated(deps.engine, row.id, created);
    current = (await loadPaymentRow(deps, row.id)) ?? row;
    deps.logger.info({ ...log, providerStatus: created.status }, 'handover payment created');
  }
  if (!isPendingPayment(current)) {
    return { providerStatus: current.status, qr: 'none' };
  }
  if (current.confirmationData === null) {
    // VERIFY: Ю9 — confirmation.confirmation_data of a qr payment.
    deps.logger.error(log, 'handover payment has no QR data');
    return { providerStatus: current.status, qr: 'none' };
  }
  const key = qrSentKey(deps, row.id);
  const fresh = await deps.redis.set(key, '1', 'EX', QR_SENT_TTL_SEC, 'NX');
  if (fresh === null) return { providerStatus: current.status, qr: 'already_sent' };
  try {
    await deps.sellerCards.sendHandoverQr({
      orderId: row.orderId,
      paymentId: row.id,
      confirmationData: current.confirmationData,
      expiresAt: current.expiresAt ?? snapshot.order.expiresAt,
    });
  } catch (error) {
    await deps.redis.del(key);
    throw error;
  }
  return { providerStatus: current.status, qr: 'sent' };
}

// ---------------------------------------------------------------------------------------------
// payment-recheck {paymentId}, refund-create {refundId}
// ---------------------------------------------------------------------------------------------

/** housekeeping asks for the truth about a pending payment (TTL never cancels a paid one). */
export async function processPaymentRecheck(
  job: Pick<Job, 'name' | 'data'>,
  deps: WorkerDeps,
): Promise<PaymentCheckOutcome> {
  const paymentId = uuidField(job, 'paymentId');
  const row = await loadPaymentRow(deps, paymentId);
  if (row === null) return { outcome: 'skipped', reason: 'not_found' };
  const outcome = await recheckPayment(deps, row, 'housekeeping');
  deps.logger.info({ orderId: row.orderId, paymentId, ...outcome }, 'payment rechecked');
  return outcome;
}

export async function processRefundCreate(
  job: Pick<Job, 'name' | 'data'>,
  deps: WorkerDeps,
): Promise<RefundOutcome> {
  const refundId = uuidField(job, 'refundId');
  const outcome = await submitRefund(deps, refundId, 'housekeeping');
  const log = { refundId, ...outcome };
  if (outcome.outcome === 'rejected') deps.logger.error(log, 'refund rejected by the provider');
  else deps.logger.info(log, 'refund submitted');
  return outcome;
}
