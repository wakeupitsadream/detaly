/**
 * Refund planning (PLAN sections 2-3, docs/phase-1b-implementation.md section 3.3).
 *
 * Invariants:
 * - the sum of refunds of a payment (pending + succeeded; failed ones do not count) never
 *   exceeds the payment amount;
 * - a refund line mirrors the item line of the receipt that took the money (description,
 *   unit price), only the remaining (not yet refunded) part is returned;
 * - a whole-order refund includes the delivery line once.
 *
 * Pure: the engine loads items and refunds and persists the plan (refunds.items, the refund
 * receipt via buildRefundReceipt).
 */
import type { OrderEvent } from './state-machine/transitions';
import type {
  ClaimKind,
  OrderItemState,
  PaymentKind,
  PaymentSubject,
  RefundReason,
  RefundStatus,
} from './statuses';
import { DELIVERY_LINE_DESCRIPTION, lineDescription, ReceiptLinesError } from './receipts';
import type { Kop, ReceiptLine } from './types';

/** An order item as receipts and refunds see it (an order_items row, reduced). */
export interface ReceiptItemInput {
  orderItemId: string;
  brand: string;
  article: string;
  name: string;
  qty: number;
  /** Client price per unit. */
  priceClientKop: Kop;
  /** order_items.refunded_amount_kop: already returned by succeeded refunds. */
  refundedAmountKop: Kop;
  state: OrderItemState;
}

/** One refund line: goes to refunds.items and, through buildRefundReceipt, to the receipt. */
export interface RefundLine {
  /** null for the delivery line. */
  orderItemId: string | null;
  subject: PaymentSubject;
  description: string;
  qty: number;
  unitPriceKop: Kop;
  /** unitPriceKop x qty. */
  amountKop: Kop;
}

/** A refunds row of the payment, reduced to what the plans need. */
export interface RefundRecord {
  amountKop: Kop;
  status: RefundStatus;
  /** refunds.items; lines of pending refunds are not refunded again. */
  items?: readonly { orderItemId: string | null; subject: PaymentSubject; amountKop: Kop }[];
}

export interface RefundPlan {
  amountKop: Kop;
  lines: RefundLine[];
}

export class RefundPlanError extends Error {
  override name = 'RefundPlanError';
}

/** Sum of refunds that hold money: pending and succeeded (failed ones returned nothing). */
export function refundedOrPendingKop(refunds: readonly RefundRecord[]): Kop {
  let sum = 0;
  for (const refund of refunds) {
    if (refund.status === 'pending' || refund.status === 'succeeded') sum += refund.amountKop;
  }
  return sum;
}

/** How much of the payment can still be refunded. */
export function refundableKop(paymentKop: Kop, refunds: readonly RefundRecord[]): Kop {
  return Math.max(0, paymentKop - refundedOrPendingKop(refunds));
}

/** Throws RefundPlanError when a new refund of newKop would exceed the payment. */
export function assertRefundWithinPayment(
  paymentKop: Kop,
  refunds: readonly RefundRecord[],
  newKop: Kop,
): void {
  if (!Number.isSafeInteger(newKop) || newKop <= 0) {
    throw new RefundPlanError('refund amount must be a positive integer of kopecks');
  }
  const left = refundableKop(paymentKop, refunds);
  if (newKop > left) {
    throw new RefundPlanError(`refund ${newKop} exceeds the refundable rest ${left}`);
  }
}

/** Amounts of pending refunds per item id (null = delivery). */
function pendingByItem(refunds: readonly RefundRecord[]): Map<string | null, Kop> {
  const map = new Map<string | null, Kop>();
  for (const refund of refunds) {
    if (refund.status !== 'pending') continue;
    for (const line of refund.items ?? []) {
      map.set(line.orderItemId, (map.get(line.orderItemId) ?? 0) + line.amountKop);
    }
  }
  return map;
}

/** Delivery already returned or being returned (pending + succeeded refunds). */
function deliveryRefundedKop(refunds: readonly RefundRecord[]): Kop {
  let sum = 0;
  for (const refund of refunds) {
    if (refund.status === 'failed') continue;
    for (const line of refund.items ?? []) if (line.subject === 'service') sum += line.amountKop;
  }
  return sum;
}

/**
 * The line for what is left of an item. A remainder that is a whole number of units keeps the
 * unit price; any other remainder is returned as one line of quantity 1.
 */
function remainderLine(item: ReceiptItemInput, alreadyKop: Kop): RefundLine | null {
  const lineKop = item.priceClientKop * item.qty;
  const restKop = lineKop - alreadyKop;
  if (restKop <= 0) return null;
  const description = lineDescription(item.brand, item.article, item.name);
  const whole = item.priceClientKop > 0 && restKop % item.priceClientKop === 0;
  const qty = whole ? restKop / item.priceClientKop : 1;
  const unitPriceKop = whole ? item.priceClientKop : restKop;
  return {
    orderItemId: item.orderItemId,
    subject: 'commodity',
    description,
    qty,
    unitPriceKop,
    amountKop: restKop,
  };
}

const notRefundable: readonly OrderItemState[] = ['failed', 'replaced', 'refunded'];

function sumLines(lines: readonly RefundLine[]): Kop {
  let sum = 0;
  for (const line of lines) sum += line.amountKop;
  return sum;
}

export interface OrderRefundInput {
  items: readonly ReceiptItemInput[];
  courierFeeKop: Kop;
  /** The succeeded payment being refunded. */
  paymentKop: Kop;
  /** Earlier refunds of this payment. */
  refunds: readonly RefundRecord[];
}

/**
 * Refund of the whole order: every live and refund_pending item without what was already
 * returned (succeeded) or is being returned (pending), plus the delivery line once.
 * Result: payment - already refunded for an order refunded after a partial refund.
 */
export function planOrderRefund(input: OrderRefundInput): RefundPlan {
  const pending = pendingByItem(input.refunds);
  const lines: RefundLine[] = [];
  for (const item of input.items) {
    if (notRefundable.includes(item.state)) continue;
    const line = remainderLine(item, item.refundedAmountKop + (pending.get(item.orderItemId) ?? 0));
    if (line !== null) lines.push(line);
  }
  const deliveryKop = input.courierFeeKop - deliveryRefundedKop(input.refunds);
  if (deliveryKop > 0) {
    lines.push({
      orderItemId: null,
      subject: 'service',
      description: DELIVERY_LINE_DESCRIPTION,
      qty: 1,
      unitPriceKop: deliveryKop,
      amountKop: deliveryKop,
    });
  }
  const amountKop = sumLines(lines);
  if (amountKop === 0) throw new RefundPlanError('nothing left to refund');
  assertRefundWithinPayment(input.paymentKop, input.refunds, amountKop);
  return { amountKop, lines };
}

export interface ItemRefundInput {
  item: ReceiptItemInput;
  /** Earlier refunds of the payment (pending lines of this item are not refunded twice). */
  refunds?: readonly RefundRecord[];
  /** When given, the plan is checked against the refundable rest of the payment. */
  paymentKop?: Kop;
}

/** Refund of one item: its remaining (not yet refunded) amount. */
export function planItemRefund(input: ItemRefundInput): RefundPlan {
  const { item } = input;
  const refunds = input.refunds ?? [];
  if (notRefundable.includes(item.state)) {
    throw new RefundPlanError(`item in state ${item.state} cannot be refunded`);
  }
  const already = item.refundedAmountKop + (pendingByItem(refunds).get(item.orderItemId) ?? 0);
  const line = remainderLine(item, already);
  if (line === null) throw new RefundPlanError('nothing left to refund for the item');
  if (input.paymentKop !== undefined) {
    assertRefundWithinPayment(input.paymentKop, refunds, line.amountKop);
  }
  return { amountKop: line.amountKop, lines: [line] };
}

export interface OrphanRefundInput {
  /** The whole payment is returned. */
  paymentKop: Kop;
  /** Default refund receipt: prepayment -> refund_prepayment, full -> refund_full. */
  paymentKind: PaymentKind;
  /**
   * The refund receipt when the caller knows better than the payment kind: refund_full for a
   * prepayment already offset by a succeeded offset receipt (54-FZ: the refund mirrors the
   * settlement sign of the last receipt that took the money).
   */
  receiptKind?: 'refund_prepayment' | 'refund_full';
  /**
   * Lines of the receipt that took the money, preferred when present: the offset receipt after
   * an offset, else the receipt sent with the payment (payments.request).
   */
  originalLines?: readonly ReceiptLine[] | null;
  /** Fallback: order items as they were paid (failed/replaced items are skipped). */
  items: readonly ReceiptItemInput[];
  courierFeeKop?: Kop;
}

/**
 * Refund of a payment that arrived for an already refunded order (decision Б11, scope orphan):
 * the whole payment with the lines of its own receipt.
 */
export function planOrphanRefund(input: OrphanRefundInput): RefundPlan & {
  receiptKind: 'refund_prepayment' | 'refund_full';
} {
  const receiptKind =
    input.receiptKind ?? (input.paymentKind === 'prepayment' ? 'refund_prepayment' : 'refund_full');
  let lines: RefundLine[];
  if (input.originalLines && input.originalLines.length > 0) {
    lines = input.originalLines.map((line) => ({
      orderItemId: null,
      subject: line.paymentSubject,
      description: line.description,
      qty: line.quantity,
      unitPriceKop: line.unitPriceKop,
      amountKop: line.unitPriceKop * line.quantity,
    }));
  } else {
    const paid: readonly OrderItemState[] = ['failed', 'replaced'];
    lines = input.items
      .filter((item) => !paid.includes(item.state))
      .map((item) => ({
        orderItemId: item.orderItemId,
        subject: 'commodity' as const,
        description: lineDescription(item.brand, item.article, item.name),
        qty: item.qty,
        unitPriceKop: item.priceClientKop,
        amountKop: item.priceClientKop * item.qty,
      }));
    const fee = input.courierFeeKop ?? 0;
    if (fee > 0) {
      lines.push({
        orderItemId: null,
        subject: 'service',
        description: DELIVERY_LINE_DESCRIPTION,
        qty: 1,
        unitPriceKop: fee,
        amountKop: fee,
      });
    }
  }
  const amountKop = sumLines(lines);
  if (amountKop !== input.paymentKop) {
    throw new ReceiptLinesError(
      `orphan refund lines sum ${amountKop} differs from the payment ${input.paymentKop}`,
    );
  }
  return { amountKop, lines, receiptKind };
}

export interface RefundReasonFacts {
  /** paidAmountKop !== totalKop (needs_attention amount_mismatch, refunded by the owner). */
  amountMismatch?: boolean;
  /** claim_refund_approved: the claim kind is the reason (refusal, not_fit, defect, delay). */
  claimKind?: ClaimKind | null;
}

/** Events whose refunds the engine creates, plus the orphan payment (not a transition). */
export type RefundingEvent = OrderEvent | 'orphan_payment';

/** Refund reason by event; events not listed refund nothing themselves ('other'). */
const REFUND_REASON_BY_EVENT: Partial<Record<RefundingEvent, RefundReason>> = {
  client_refused: 'refusal',
  storage_expired: 'no_show',
  item_cancelled: 'supplier_fail',
  order_cancelled: 'supplier_fail',
  approval_timeout: 'supplier_fail',
  client_refund_requested: 'supplier_fail',
  // a payment of a cancelled order (cancelled + payment_succeeded) or of a refunded one
  payment_succeeded: 'late_payment',
  orphan_payment: 'late_payment',
};

/** refunds.reason for the event that creates the refund. */
export function refundReasonFor(
  event: RefundingEvent,
  facts: RefundReasonFacts = {},
): RefundReason {
  if (facts.amountMismatch === true) return 'amount_mismatch';
  // claims: the claim kind is the reason (refusal, not_fit, defect, delay)
  if (event === 'claim_refund_approved') return facts.claimKind ?? 'other';
  return REFUND_REASON_BY_EVENT[event] ?? 'other';
}
