/**
 * 54-FZ receipt payloads (PLAN sections 2 and 4, docs/phase-1b-implementation.md section 3.3).
 *
 * Invariants checked on every built receipt (assertReceiptLines):
 * - only `commodity` lines plus at most one `service` line (delivery); installation can never
 *   appear in a receipt (it is a Service56 service paid at the service);
 * - one payment_mode per receipt: full_prepayment for the prepay payment and its refund,
 *   full_payment for the handover payment, the offset receipt and refunds after them;
 * - the sum of lines (unit price x quantity) equals the amount;
 * - a line description is 1..128 characters.
 *
 * Every line built here, the delivery line included, has measure RECEIPT_ITEM_MEASURE ('piece',
 * FFD 1.2 tag 2108). A refund line gets it too when it mirrors a receipt stored without one.
 *
 * Items in the states failed, replaced, refund_pending and refunded are not part of the order
 * any more and never go into a payment or offset receipt.
 */
import {
  DROPPED_ORDER_ITEM_STATES,
  type PaymentMode,
  RECEIPT_ITEM_MEASURE,
  type ReceiptKind,
} from './statuses';
import type { Kop, ReceiptData, ReceiptLine } from './types';
import type { ReceiptItemInput, RefundLine } from './refunds';

export const RECEIPT_DESCRIPTION_MAX = 128;

/** Description of the delivery line (the only `service` line a receipt may have). */
export const DELIVERY_LINE_DESCRIPTION = 'Доставка';

export class ReceiptLinesError extends Error {
  override name = 'ReceiptLinesError';
}

/** 'MANN W 914/2 Фильтр масляный', collapsed spaces, cut to 128 characters with '…'. */
export function lineDescription(brand: string, article: string, name: string): string {
  const text = `${brand} ${article} ${name}`.replace(/\s+/gu, ' ').trim();
  const chars = [...text];
  return chars.length <= RECEIPT_DESCRIPTION_MAX
    ? text
    : `${chars.slice(0, RECEIPT_DESCRIPTION_MAX - 1).join('')}…`;
}

export function linesTotalKop(lines: readonly ReceiptLine[]): Kop {
  let total = 0;
  for (const line of lines) total += line.unitPriceKop * line.quantity;
  if (!Number.isSafeInteger(total)) throw new ReceiptLinesError('receipt total overflow');
  return total;
}

/** Throws ReceiptLinesError when any invariant is broken. */
export function assertReceiptLines(
  lines: readonly ReceiptLine[],
  expected: { totalKop: Kop; paymentMode: PaymentMode },
): void {
  if (lines.length === 0) throw new ReceiptLinesError('receipt has no lines');
  let services = 0;
  for (const [i, line] of lines.entries()) {
    const desc = line.description.trim();
    if (desc === '' || [...desc].length > RECEIPT_DESCRIPTION_MAX) {
      throw new ReceiptLinesError(`line ${i}: description must be 1..128 characters`);
    }
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new ReceiptLinesError(`line ${i}: quantity must be a positive integer`);
    }
    if (!Number.isSafeInteger(line.unitPriceKop) || line.unitPriceKop <= 0) {
      throw new ReceiptLinesError(`line ${i}: unit price must be a positive integer of kopecks`);
    }
    if (line.paymentMode !== expected.paymentMode) {
      throw new ReceiptLinesError(`line ${i}: payment_mode must be ${expected.paymentMode}`);
    }
    if (line.paymentSubject === 'service') services += 1;
    else if (line.paymentSubject !== 'commodity') {
      throw new ReceiptLinesError(`line ${i}: unsupported payment_subject`);
    }
  }
  if (services > 1) throw new ReceiptLinesError('at most one service line (delivery) is allowed');
  const total = linesTotalKop(lines);
  if (total !== expected.totalKop) {
    throw new ReceiptLinesError(`lines sum ${total} differs from amount ${expected.totalKop}`);
  }
}

/**
 * receipt.customer.phone: E.164 digits without '+' ('+79123456789' -> '79123456789').
 * VERIFY: Ю11 — the exact phone format YooKassa accepts in receipt.customer.phone.
 */
export function receiptCustomerPhone(e164: string): string {
  const digits = e164.trim().replace(/^\+/u, '');
  if (!/^\d{10,15}$/u.test(digits)) {
    throw new ReceiptLinesError('customer phone must be E.164 (10..15 digits)');
  }
  return digits;
}

/**
 * Settlement method of a receipt kind: the refund mirrors the receipt that took the money.
 * A correction receipt has no fixed mode and is not built here.
 */
export function paymentModeFor(kind: ReceiptKind): PaymentMode {
  switch (kind) {
    case 'prepayment':
    case 'refund_prepayment':
      return 'full_prepayment';
    case 'full':
    case 'offset':
    case 'refund_full':
      return 'full_payment';
    case 'correction':
      throw new ReceiptLinesError('a correction receipt has no fixed payment_mode');
  }
}

/** Codes from env (YOOKASSA_VAT_CODE, YOOKASSA_TAX_SYSTEM_CODE) and the client phone (E.164). */
export interface ReceiptCodes {
  /** E.164 phone of the client; goes to receipt.customer.phone only. */
  phone: string;
  vatCode: number;
  taxSystemCode: number;
}

const dropped: readonly string[] = DROPPED_ORDER_ITEM_STATES;

/** Items that are part of the order (not failed, replaced or refunded). */
export function liveReceiptItems(items: readonly ReceiptItemInput[]): ReceiptItemInput[] {
  return items.filter((item) => !dropped.includes(item.state));
}

function commodityLine(item: ReceiptItemInput, mode: PaymentMode, vatCode: number): ReceiptLine {
  if (item.refundedAmountKop !== 0) {
    // A live item is never partially refunded before handover (an item refund takes the whole
    // remainder and drops the item); a payment or offset receipt for such an item would lie.
    throw new ReceiptLinesError(`item ${item.orderItemId} is partially refunded`);
  }
  return {
    description: lineDescription(item.brand, item.article, item.name),
    quantity: item.qty,
    measure: RECEIPT_ITEM_MEASURE,
    unitPriceKop: item.priceClientKop,
    vatCode,
    paymentSubject: 'commodity',
    paymentMode: mode,
  };
}

function deliveryLine(courierFeeKop: Kop, mode: PaymentMode, vatCode: number): ReceiptLine[] {
  if (courierFeeKop === 0) return [];
  return [
    {
      description: DELIVERY_LINE_DESCRIPTION,
      quantity: 1,
      measure: RECEIPT_ITEM_MEASURE,
      unitPriceKop: courierFeeKop,
      vatCode,
      paymentSubject: 'service',
      paymentMode: mode,
    },
  ];
}

function assembled(
  lines: ReceiptLine[],
  mode: PaymentMode,
  codes: ReceiptCodes,
): { data: ReceiptData; amountKop: Kop } {
  const amountKop = linesTotalKop(lines);
  assertReceiptLines(lines, { totalKop: amountKop, paymentMode: mode });
  return {
    data: {
      customer: { phone: receiptCustomerPhone(codes.phone) },
      lines,
      taxSystemCode: codes.taxSystemCode,
    },
    amountKop,
  };
}

export interface PaymentReceiptInput extends ReceiptCodes {
  /** prepayment: online prepay (full_prepayment); full: payment at handover (full_payment). */
  kind: 'prepayment' | 'full';
  /** All order items; dropped ones are skipped. */
  items: readonly ReceiptItemInput[];
  courierFeeKop: Kop;
}

/**
 * Receipt sent inside POST /payments. `amountKop` is the sum of live items plus delivery and
 * must equal orders.total_kop (the caller compares; the payment amount is always the total).
 */
export function buildPaymentReceipt(input: PaymentReceiptInput): {
  data: ReceiptData;
  amountKop: Kop;
} {
  const mode = paymentModeFor(input.kind);
  const lines = [
    ...liveReceiptItems(input.items).map((item) => commodityLine(item, mode, input.vatCode)),
    ...deliveryLine(input.courierFeeKop, mode, input.vatCode),
  ];
  return assembled(lines, mode, input);
}

export interface OffsetReceiptInput extends ReceiptCodes {
  /** All order items; only live ones are handed over and offset. */
  items: readonly ReceiptItemInput[];
  courierFeeKop: Kop;
}

/**
 * Final settlement with prepayment offset (POST /receipts at «Клиент пришёл»): the items
 * actually handed over, full_payment, settlements [{type: prepayment, amount}]. After a partial
 * refund of an item the offset covers only the rest: prepaymentKop = payment - refunded.
 */
export function buildOffsetReceipt(input: OffsetReceiptInput): {
  data: ReceiptData;
  prepaymentKop: Kop;
} {
  const mode = paymentModeFor('offset');
  const lines = [
    ...liveReceiptItems(input.items).map((item) => commodityLine(item, mode, input.vatCode)),
    ...deliveryLine(input.courierFeeKop, mode, input.vatCode),
  ];
  const { data, amountKop } = assembled(lines, mode, input);
  return { data, prepaymentKop: amountKop };
}

export interface RefundReceiptInput extends ReceiptCodes {
  /** Mirrors the receipt that took the money (refundReceipt in the state machine). */
  kind: 'refund_prepayment' | 'refund_full';
  /** From planOrderRefund / planItemRefund / planOrphanRefund. */
  lines: readonly RefundLine[];
}

/** Refund receipt sent inside POST /refunds: the returned lines with the original payment_mode. */
export function buildRefundReceipt(input: RefundReceiptInput): {
  data: ReceiptData;
  amountKop: Kop;
} {
  const mode = paymentModeFor(input.kind);
  const lines = input.lines.map((line): ReceiptLine => ({
    description: line.description,
    quantity: line.qty,
    measure: RECEIPT_ITEM_MEASURE,
    unitPriceKop: line.unitPriceKop,
    vatCode: input.vatCode,
    paymentSubject: line.subject,
    paymentMode: mode,
  }));
  return assembled(lines, mode, input);
}
