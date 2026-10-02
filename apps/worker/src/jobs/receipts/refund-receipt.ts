// receipts/refund-receipt {receiptId} (54-FZ): the refund receipt sent inside POST /refunds is
// registered after the money moved. applyRefundObject marks it succeeded at once when the refund
// object already says receipt_registration = succeeded; otherwise this job asks again: GET
// /refunds/{id} (receipt_registration, VERIFY: Ю10) and GET /receipts?refund_id= (VERIFY), every
// 2 minutes for 15 minutes, then one alert to the owner (staff_refund_receipt_failed) and every
// 10 minutes for a day. The refund itself is done: nothing here moves the order.
import { RECEIPTS_JOBS } from '@detaly/config';
import { applyReceiptObject, type ReceiptRow } from '@detaly/orders';
import type { ProviderReceipt, ProviderRefund, ReceiptProvider } from '@detaly/payments';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { loadRefundRow } from '../payments/money';
import {
  classifyProviderError,
  failureMessage,
  failureText,
  requirePayments,
  requireReceipts,
  uuidField,
  type ProviderFailure,
} from '../payments/shared';
import {
  alertReceiptFailed,
  loadReceiptRow,
  schedulePoll,
  slowPollsOver,
  startAttempt,
  windowElapsed,
} from './polling';

export type RefundReceiptJobResult =
  | { skipped: string }
  | { status: 'succeeded' }
  | { status: 'canceled'; alerted: boolean }
  | { status: 'pending'; nextPollAt: string | null; alerted?: boolean };

const REFUND_KINDS: readonly string[] = ['refund_prepayment', 'refund_full'];

/** receipt_registration of a refund object (the parsed field, else the raw answer). */
function registrationOf(refund: ProviderRefund): string | null {
  if (refund.receiptRegistration) return refund.receiptRegistration;
  const raw = refund.raw as { receipt_registration?: unknown } | null;
  return typeof raw?.receipt_registration === 'string' ? raw.receipt_registration : null;
}

/** The refund's own receipt among GET /receipts?refund_id= (VERIFY: list format). */
async function listed(
  receipts: ReceiptProvider,
  refund: ProviderRefund,
  row: ReceiptRow,
): Promise<ProviderReceipt | null> {
  try {
    const list = (await receipts.listRefundReceipts(refund.id)).filter((r) => r.type === 'refund');
    return list.find((r) => r.id === row.providerReceiptId) ?? list[0] ?? null;
  } catch (error) {
    const failure = classifyProviderError(error);
    // The list endpoint is VERIFY: a final error means "unknown", not "failed".
    if (failure !== null && failure.kind === 'final') return null;
    throw error;
  }
}

/** The refund object is the proof when the receipt list does not show the receipt. */
function receiptFromRefund(refund: ProviderRefund, row: ReceiptRow): ProviderReceipt {
  return {
    id: row.providerReceiptId ?? refund.id,
    type: 'refund',
    status: 'succeeded',
    paymentId: refund.paymentId,
    refundId: refund.id,
    fiscalDocumentNumber: row.fiscalDocumentNumber,
    paymentMode: null,
    settlementTypes: [],
    registeredAt: null,
    raw: { source: 'refund.receipt_registration', refund_id: refund.id },
  };
}

export async function processRefundReceipt(
  job: Pick<Job, 'name' | 'data'>,
  deps: WorkerDeps,
): Promise<RefundReceiptJobResult> {
  const receiptId = uuidField(job, 'receiptId');
  const row = await loadReceiptRow(deps, receiptId);
  if (row === null) return { skipped: 'not_found' };
  if (!REFUND_KINDS.includes(row.kind)) {
    throw new UnrecoverableError(`receipt kind ${row.kind} is not a refund receipt`);
  }
  if (row.status !== 'pending') return { skipped: row.status };
  const refundRow = row.refundId ? await loadRefundRow(deps, row.refundId) : null;
  if (refundRow === null || refundRow.providerRefundId === null) return { skipped: 'no_refund' };
  if (refundRow.status !== 'succeeded') return { skipped: `refund_${refundRow.status}` };
  const payments = requirePayments(deps);
  const receipts = requireReceipts(deps);
  const log = { orderId: row.orderId, receiptId, refundId: refundRow.id };
  const windowStart = await startAttempt(deps, row.id, { restart: false });

  let found: ProviderReceipt | null = null;
  let registration: string | null = null;
  let failure: ProviderFailure | null = null;
  try {
    const refund = await payments.getRefund(refundRow.providerRefundId);
    registration = registrationOf(refund);
    if (registration === 'succeeded') {
      found = {
        ...((await listed(receipts, refund, row)) ?? receiptFromRefund(refund, row)),
        status: 'succeeded',
      };
    } else if (registration !== 'canceled') {
      found = await listed(receipts, refund, row);
    }
  } catch (error) {
    failure = classifyProviderError(error);
    if (failure === null) throw error;
  }

  if (registration === 'canceled' || found?.status === 'canceled') {
    await applyReceiptObject(deps.engine, row.id, {
      error: { code: 'canceled', message: 'refund receipt_registration canceled', final: true },
    });
    const alerted = await alertReceiptFailed(deps, row.id, {
      code: 'canceled',
      note: 'ЮKassa не зарегистрировала чек возврата.',
      template: 'staff_refund_receipt_failed',
      audiences: ['owner'],
    });
    deps.logger.error(log, 'refund receipt canceled by the provider');
    return { status: 'canceled', alerted };
  }
  if (found !== null) {
    const applied = await applyReceiptObject(deps.engine, row.id, found);
    if (applied.status === 'succeeded') {
      deps.logger.info(log, 'refund receipt succeeded');
      return { status: 'succeeded' };
    }
  } else if (failure !== null) {
    await applyReceiptObject(deps.engine, row.id, {
      error: { code: failure.code, message: failureMessage(failure), final: false },
    });
    deps.logger.warn({ ...log, error: failureText(failure) }, 'refund receipt check failed');
  }

  const elapsed = windowElapsed(deps, windowStart);
  let alerted: boolean | undefined;
  if (elapsed) {
    alerted = await alertReceiptFailed(deps, row.id, {
      code: 'timeout',
      note: 'Чек возврата не зарегистрирован за 15 минут.',
      template: 'staff_refund_receipt_failed',
      audiences: ['owner'],
    });
    if (alerted) deps.logger.error(log, 'refund receipt not registered in 15 minutes');
    if (slowPollsOver(deps, windowStart)) return { status: 'pending', nextPollAt: null, alerted };
  }
  const nextPollAt = await schedulePoll(deps, {
    receipt: row,
    windowStart,
    name: RECEIPTS_JOBS.refundReceipt,
    keyPrefix: 'refund-receipt-poll',
    slow: elapsed,
  });
  return {
    status: 'pending',
    nextPollAt: nextPollAt.toISOString(),
    ...(alerted === undefined ? {} : { alerted }),
  };
}
