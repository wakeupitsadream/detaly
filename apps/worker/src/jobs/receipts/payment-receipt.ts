// receipts/payment-receipt {receiptId} (decision Б23): the receipt sent inside a payment
// (prepayment online, full at the pickup point). Its state comes from the payment object
// (`receipt_registration`), the receipt itself from GET /receipts?payment_id=; polled like the
// offset receipt. A succeeded `full` receipt unlocks «Выдал», so the seller card is redrawn.
import { RECEIPTS_JOBS } from '@detaly/config';
import { applyReceiptObject, type PaymentRow, type ReceiptRow } from '@detaly/orders';
import type { ProviderPayment, ProviderReceipt, ReceiptProvider } from '@detaly/payments';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { loadPaymentRow } from '../payments/money';
import {
  classifyProviderError,
  failureMessage,
  failureText,
  requirePayments,
  requireReceipts,
  uuidField,
  type ProviderFailure,
} from '../payments/shared';
import { refreshCard } from './offset';
import {
  alertReceiptFailed,
  loadReceiptRow,
  schedulePoll,
  startAttempt,
  windowElapsed,
} from './polling';

export type PaymentReceiptJobResult =
  | { skipped: string }
  | { status: 'succeeded' | 'canceled'; alerted?: boolean }
  | { status: 'pending'; nextPollAt?: string; alerted?: boolean };

const MODE_BY_KIND = { prepayment: 'full_prepayment', full: 'full_payment' } as const;

/**
 * The payment's own receipt among GET /receipts?payment_id=: a payment receipt that is not the
 * offset one (settlement `prepayment`) and has the payment_mode of the payment kind.
 * VERIFY: Ю1 — list format and settlements of a receipt sent inside a payment.
 */
function ownReceipt(list: readonly ProviderReceipt[], row: ReceiptRow): ProviderReceipt | null {
  const mode = MODE_BY_KIND[row.kind as keyof typeof MODE_BY_KIND];
  const candidates = list.filter(
    (r) =>
      r.type === 'payment' &&
      !r.settlementTypes.includes('prepayment') &&
      (r.paymentMode === null || r.paymentMode === mode),
  );
  return candidates.find((r) => r.id === row.providerReceiptId) ?? candidates[0] ?? null;
}

/**
 * When the payment says receipt_registration=succeeded but the receipt list does not show it
 * (VERIFY: Ю1 — GET /receipts?payment_id= may be unavailable), the payment object is the proof:
 * the payment id stands in for the receipt id.
 */
function receiptFromPayment(payment: ProviderPayment, row: ReceiptRow): ProviderReceipt {
  return {
    id: row.providerReceiptId ?? payment.id,
    type: 'payment',
    status: 'succeeded',
    paymentId: payment.id,
    refundId: null,
    fiscalDocumentNumber: row.fiscalDocumentNumber,
    paymentMode: MODE_BY_KIND[row.kind as keyof typeof MODE_BY_KIND] ?? null,
    settlementTypes: [],
    registeredAt: null,
    raw: { source: 'payment.receipt_registration', payment_id: payment.id },
  };
}

async function findReceipt(
  receipts: ReceiptProvider,
  payment: ProviderPayment,
  row: ReceiptRow,
): Promise<ProviderReceipt | null> {
  try {
    return ownReceipt(await receipts.listPaymentReceipts(payment.id), row);
  } catch (error) {
    const failure = classifyProviderError(error);
    // The list endpoint is VERIFY: a final error means "unknown", not "failed".
    if (failure !== null && failure.kind === 'final') return null;
    throw error;
  }
}

export async function processPaymentReceipt(
  job: Pick<Job, 'name' | 'data'>,
  deps: WorkerDeps,
): Promise<PaymentReceiptJobResult> {
  const receiptId = uuidField(job, 'receiptId');
  const row = await loadReceiptRow(deps, receiptId);
  if (row === null) return { skipped: 'not_found' };
  if (row.kind !== 'prepayment' && row.kind !== 'full') {
    throw new UnrecoverableError(`receipt kind ${row.kind} is not sent inside a payment`);
  }
  if (row.status !== 'pending') return { skipped: row.status };
  const payment: PaymentRow | null = row.paymentId
    ? await loadPaymentRow(deps, row.paymentId)
    : null;
  if (payment === null || payment.providerPaymentId === null) return { skipped: 'no_payment' };
  if (payment.status !== 'succeeded') return { skipped: `payment_${payment.status}` };
  const payments = requirePayments(deps);
  const receipts = requireReceipts(deps);
  const log = { orderId: row.orderId, receiptId, kind: row.kind };
  const windowStart = await startAttempt(deps, row.id, { restart: false });

  let found: ProviderReceipt | null = null;
  let registration: ProviderPayment['receiptRegistration'] = null;
  let failure: ProviderFailure | null = null;
  try {
    const providerPayment = await payments.getPayment(payment.providerPaymentId);
    registration = providerPayment.receiptRegistration;
    if (registration === 'succeeded') {
      found =
        (await findReceipt(receipts, providerPayment, row)) ??
        receiptFromPayment(providerPayment, row);
      // receipt_registration of the payment is the authority on the outcome (Б23).
      found = { ...found, status: 'succeeded' };
    } else if (registration !== 'canceled') {
      found = await findReceipt(receipts, providerPayment, row);
    }
  } catch (error) {
    failure = classifyProviderError(error);
    if (failure === null) throw error;
  }

  if (registration === 'canceled' || found?.status === 'canceled') {
    await applyReceiptObject(deps.engine, row.id, {
      error: { code: 'canceled', message: 'receipt_registration canceled', final: true },
    });
    const alerted = await alertReceiptFailed(deps, row.id, {
      code: 'canceled',
      note:
        row.kind === 'full'
          ? 'ЮKassa не зарегистрировала чек оплаты на точке.'
          : 'ЮKassa не зарегистрировала чек предоплаты.',
    });
    deps.logger.error(log, 'payment receipt canceled by the provider');
    return { status: 'canceled', alerted };
  }
  if (found !== null) {
    const applied = await applyReceiptObject(deps.engine, row.id, found);
    if (applied.status === 'succeeded') {
      if (row.kind === 'full') await refreshCard(deps, row);
      deps.logger.info(log, 'payment receipt succeeded');
      return { status: 'succeeded' };
    }
  } else if (failure !== null) {
    await applyReceiptObject(deps.engine, row.id, {
      error: { code: failure.code, message: failureMessage(failure), final: false },
    });
    deps.logger.warn({ ...log, error: failureText(failure) }, 'payment receipt check failed');
  }

  if (windowElapsed(deps, windowStart)) {
    const alerted = await alertReceiptFailed(deps, row.id, {
      code: 'timeout',
      note: 'Чек в составе платежа не зарегистрирован за 15 минут.',
    });
    if (alerted && row.kind === 'full') await refreshCard(deps, row);
    deps.logger.error(log, 'payment receipt not registered in 15 minutes');
    return { status: 'pending', alerted };
  }
  const nextPollAt = await schedulePoll(deps, {
    receipt: row,
    windowStart,
    name: RECEIPTS_JOBS.paymentReceipt,
    keyPrefix: 'payment-receipt-poll',
  });
  return { status: 'pending', nextPollAt: nextPollAt.toISOString() };
}
