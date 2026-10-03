/**
 * Rows that carry money and receipts, written inside the caller's transaction (which holds the
 * order row lock): payments with their receipt (Б5–Б7), refunds with the refund receipt
 * (createRefund), the offset receipt («Клиент пришёл», Б22). Each queues its provider call
 * through the outbox; nothing here calls a provider.
 *
 * The client phone goes only into the provider request stored in the database (receipt
 * customer.phone); it is never returned, logged or put into order_events.
 */
import type { Env } from '@detaly/config';
import { payments, receipts, refunds } from '@detaly/db';
import {
  assertRefundWithinPayment,
  buildOffsetReceipt,
  buildPaymentReceipt,
  buildRefundReceipt,
  planItemRefund,
  planOrderRefund,
  planOrphanRefund,
  RefundPlanError,
  type Kop,
  type ReceiptItemInput,
  type ReceiptLine,
  type RefundPlan,
  type RefundReason,
  type RefundRecord,
  type RefundScope,
} from '@detaly/domain';
import type { CreatePaymentRequest } from '@detaly/payments';
import { v7 as uuidv7 } from 'uuid';
import { heldPayments, isLiveState, paymentRestKop } from './context';
import { enqueueOutbox, recordJournalEvent } from './journal';
import { loadClientPhone } from './snapshot';
import type { ActorRef, OrderItemRow, OrderSnapshot, PaymentRow, RefundRow, Tx } from './types';

/** Days the client waits for the money at most (ст. 22 ЗоЗПП, PLAN section 2). */
export const REFUND_DEADLINE_DAYS = 10;
const DAY_MS = 86_400_000;

/**
 * A precondition of an effect does not hold (no payment to refund, no phone for the receipt,
 * payments not configured). Thrown before or while writing; applyTransition rolls its savepoint
 * back and answers guard_failed with `code`.
 */
export class EngineError extends Error {
  override name = 'EngineError';
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message);
  }
}

export const SYSTEM_ACTOR: ActorRef = { type: 'system', id: null };

/** Б6: payments (and therefore every receipt) need these four variables. */
export function paymentsEnabled(env: Env): boolean {
  return (
    env.YOOKASSA_SHOP_ID !== undefined &&
    env.YOOKASSA_SECRET_KEY !== undefined &&
    env.YOOKASSA_VAT_CODE !== undefined &&
    env.YOOKASSA_TAX_SYSTEM_CODE !== undefined
  );
}

export interface ReceiptCodesOnly {
  vatCode: number;
  taxSystemCode: number;
}

interface StoredPaymentRequest {
  receipt?: { lines?: ReceiptLine[]; taxSystemCode?: number } | null;
}

/** Lines of the succeeded offset receipt registered against `paymentId` (receipts.request.lines). */
export function offsetReceiptLines(
  snapshot: OrderSnapshot,
  paymentId: string,
): ReceiptLine[] | null {
  const offset = snapshot.receipts.find(
    (r) => r.kind === 'offset' && r.status === 'succeeded' && r.paymentId === paymentId,
  );
  const lines = (offset?.request as { lines?: ReceiptLine[] } | null | undefined)?.lines;
  return Array.isArray(lines) && lines.length > 0 ? lines : null;
}

/** Lines of the receipt sent with a payment (payments.request.receipt.lines). */
export function paymentReceiptLines(payment: PaymentRow): ReceiptLine[] | null {
  const request = payment.request as StoredPaymentRequest | null;
  const lines = request?.receipt?.lines;
  return Array.isArray(lines) && lines.length > 0 ? lines : null;
}

/** VAT and tax system codes: env first, else those of the payment's own receipt. */
export function receiptCodesFor(env: Env, payment?: PaymentRow | null): ReceiptCodesOnly | null {
  if (env.YOOKASSA_VAT_CODE !== undefined && env.YOOKASSA_TAX_SYSTEM_CODE !== undefined) {
    return { vatCode: env.YOOKASSA_VAT_CODE, taxSystemCode: env.YOOKASSA_TAX_SYSTEM_CODE };
  }
  const request = payment?.request as StoredPaymentRequest | null | undefined;
  const vatCode = request?.receipt?.lines?.[0]?.vatCode;
  const taxSystemCode = request?.receipt?.taxSystemCode;
  return typeof vatCode === 'number' && typeof taxSystemCode === 'number'
    ? { vatCode, taxSystemCode }
    : null;
}

export function receiptItemInput(item: OrderItemRow): ReceiptItemInput {
  return {
    orderItemId: item.id,
    brand: item.brand,
    article: item.article,
    name: item.name,
    qty: item.qty,
    priceClientKop: item.priceClientKop,
    refundedAmountKop: item.refundedAmountKop,
    state: item.state,
  };
}

async function requirePhone(tx: Tx, snapshot: OrderSnapshot): Promise<string> {
  const phone = await loadClientPhone(tx, snapshot.order.userId);
  if (phone === null) throw new EngineError('no_phone', 'client phone is missing or anonymized');
  return phone;
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

/** CreatePaymentRequest with metadata (Б7); the payments package adds `metadata` in wave 2. */
export type PaymentRequestWithMetadata = CreatePaymentRequest & {
  metadata: Record<string, string>;
};

/**
 * New payments row (pending, new Idempotence-Key = uuid v7, amount = orders.total_kop, request
 * with the receipt and metadata) and its receipts row (prepayment / full, key `<key>:receipt`).
 */
export async function createPaymentRows(
  tx: Tx,
  snapshot: OrderSnapshot,
  input: {
    kind: 'prepayment' | 'full';
    confirmation: 'redirect' | 'qr';
    returnUrl: string;
    env: Env;
  },
): Promise<{ paymentRowId: string; receiptId: string; request: PaymentRequestWithMetadata }> {
  const { env } = input;
  if (!paymentsEnabled(env)) throw new EngineError('payments_disabled');
  const codes = receiptCodesFor(env) as ReceiptCodesOnly;
  const phone = await requirePhone(tx, snapshot);
  const { order } = snapshot;
  const receipt = buildPaymentReceipt({
    kind: input.kind,
    items: snapshot.items.map(receiptItemInput),
    courierFeeKop: order.courierFeeKop,
    phone,
    vatCode: codes.vatCode,
    taxSystemCode: codes.taxSystemCode,
  });
  if (receipt.amountKop !== order.totalKop) {
    throw new EngineError(
      'receipt_total_mismatch',
      `receipt lines ${receipt.amountKop} differ from the order total ${order.totalKop}`,
    );
  }
  const paymentRowId = uuidv7();
  const idempotenceKey = uuidv7();
  const request: PaymentRequestWithMetadata = {
    orderId: order.id,
    orderNumber: order.number,
    amountKop: order.totalKop,
    idempotenceKey,
    returnUrl: input.returnUrl,
    confirmation: input.confirmation,
    receipt: receipt.data,
    // VERIFY: Ю11 — metadata limits (16 keys, 512 characters per value).
    metadata: { order_id: order.id, order_number: order.number, payment_row_id: paymentRowId },
  };
  await tx.insert(payments).values({
    id: paymentRowId,
    orderId: order.id,
    kind: input.kind,
    status: 'pending',
    amountKop: order.totalKop,
    idempotenceKey,
    confirmationType: input.confirmation,
    request,
  });
  const receiptId = uuidv7();
  await tx.insert(receipts).values({
    id: receiptId,
    orderId: order.id,
    paymentId: paymentRowId,
    kind: input.kind,
    idempotenceKey: `${idempotenceKey}:receipt`,
    status: 'pending',
    request: receipt.data,
  });
  return { paymentRowId, receiptId, request };
}

// ---------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------

export interface RefundTarget {
  scope: RefundScope;
  paymentId: string;
  itemIds?: string[];
}

function refundRecords(snapshot: OrderSnapshot, paymentId: string): RefundRecord[] {
  return snapshot.refunds
    .filter((r) => r.paymentId === paymentId)
    .map((r) => ({ amountKop: r.amountKop, status: r.status, items: r.items }));
}

/**
 * Pure refund plan of a target: lines, amount and the refund receipt kind, which mirrors the
 * receipt that took the money (refund_full after a full payment or a succeeded offset receipt,
 * refund_prepayment before the offset). Throws RefundPlanError / EngineError.
 */
export function planRefund(
  snapshot: OrderSnapshot,
  target: RefundTarget,
): {
  payment: PaymentRow;
  plan: RefundPlan;
  receiptKind: 'refund_prepayment' | 'refund_full';
} {
  const payment = snapshot.payments.find((p) => p.id === target.paymentId);
  if (payment === undefined || payment.status !== 'succeeded') {
    throw new EngineError('no_refundable_payment', 'the payment is not succeeded');
  }
  if (payment.providerPaymentId === null) {
    throw new EngineError('no_refundable_payment', 'the payment has no provider id');
  }
  const records = refundRecords(snapshot, payment.id);
  const items = snapshot.items.map(receiptItemInput);
  const offsetSucceeded = snapshot.receipts.some(
    (r) => r.kind === 'offset' && r.status === 'succeeded' && r.paymentId === payment.id,
  );
  const mirrored: 'refund_prepayment' | 'refund_full' =
    payment.kind === 'full' || offsetSucceeded ? 'refund_full' : 'refund_prepayment';
  // A whole payment goes back with the lines of the receipt that took the money last: the
  // offset receipt (full_payment) after an offset, else the payment's own receipt.
  const wholePayment = () => {
    const orphan = planOrphanRefund({
      paymentKop: payment.amountKop,
      paymentKind: payment.kind,
      receiptKind: mirrored,
      originalLines:
        (offsetSucceeded ? offsetReceiptLines(snapshot, payment.id) : null) ??
        paymentReceiptLines(payment),
      items,
      courierFeeKop: snapshot.order.courierFeeKop,
    });
    return { plan: { amountKop: orphan.amountKop, lines: orphan.lines }, kind: orphan.receiptKind };
  };

  let plan: RefundPlan;
  let receiptKind = mirrored;
  switch (target.scope) {
    case 'item': {
      const itemId = target.itemIds?.[0];
      const item = items.find((i) => i.orderItemId === itemId);
      if (item === undefined) throw new RefundPlanError('refund item not found');
      plan = planItemRefund({ item, refunds: records, paymentKop: payment.amountKop });
      break;
    }
    case 'order': {
      const untouched = !records.some((r) => r.status !== 'failed');
      let orderPlan: RefundPlan | null = null;
      try {
        orderPlan = planOrderRefund({
          items,
          courierFeeKop: snapshot.order.courierFeeKop,
          paymentKop: payment.amountKop,
          refunds: records,
        });
      } catch (error) {
        if (!untouched) throw error;
      }
      if (orderPlan !== null && (!untouched || orderPlan.amountKop === payment.amountKop)) {
        plan = orderPlan;
      } else {
        // A payment whose amount differs from the order (a late payment of a cancelled order)
        // and was not refunded at all: it is returned whole with the lines of its own receipt.
        ({ plan, kind: receiptKind } = wholePayment());
      }
      break;
    }
    case 'orphan': {
      if (records.some((r) => r.status !== 'failed')) {
        throw new RefundPlanError('the payment was already (partly) refunded');
      }
      ({ plan, kind: receiptKind } = wholePayment());
      break;
    }
  }
  assertRefundWithinPayment(payment.amountKop, records, plan.amountKop);
  return { payment, plan, receiptKind };
}

/**
 * refunds row (deadline_at = requested_at + 10 days, request) and its refund receipt, checked
 * with assertRefundWithinPayment; outbox payments/refund-create. The caller holds the lock.
 * The refund receipt mirrors the settlement sign of the receipt that took the money.
 */
export async function createRefund(
  tx: Tx,
  snapshot: OrderSnapshot,
  input: {
    scope: RefundScope;
    paymentId: string;
    reason: RefundReason;
    itemIds?: string[];
    /** When the client asked for the money: refunds.requested_at and the 10-day deadline. */
    requestedAt: Date;
    /**
     * When the refund is created (journal `refund_created`); default requestedAt. A claim refund
     * is requested at claims.opened_at but created when the decision is made.
     */
    at?: Date;
    /** Who caused it (journal `refund_created`); default system. */
    actor?: ActorRef;
    /** Receipt codes; default: those of the payment's own receipt, then `env`. */
    codes?: ReceiptCodesOnly;
    env?: Env;
    /** Free text for the journal (owner's reason), without PD. */
    note?: string;
    /**
     * The failed refund (or refund task) this one takes over: its deadline_at is kept (the 10
     * days of ст. 22 run from the first request, not from the retry) and refunds.retry_of
     * links the rows.
     */
    retryOf?: Pick<RefundRow, 'id' | 'deadlineAt'> | null;
  },
): Promise<{ refundId: string; receiptId: string; amountKop: Kop }> {
  const { payment, plan, receiptKind } = planRefund(snapshot, input);
  // A whole payment going back takes over its open refund task (deadline and reminders).
  const retryOf =
    input.retryOf ??
    (input.scope === 'orphan'
      ? (openRefundTasks(snapshot).find((task) => task.paymentId === payment.id) ?? null)
      : null);
  const codes =
    input.codes ??
    receiptCodesFromPayment(payment) ??
    (input.env ? receiptCodesFor(input.env) : null);
  if (codes === null) throw new EngineError('receipt_codes_missing');
  const phone = await requirePhone(tx, snapshot);
  const receipt = buildRefundReceipt({
    kind: receiptKind,
    lines: plan.lines,
    phone,
    vatCode: codes.vatCode,
    taxSystemCode: codes.taxSystemCode,
  });
  const refundId = uuidv7();
  const idempotenceKey = uuidv7();
  const request = {
    paymentId: payment.providerPaymentId as string,
    amountKop: plan.amountKop,
    idempotenceKey,
    description: `Возврат по заказу ${snapshot.order.number}`,
    receipt: receipt.data,
  };
  await tx.insert(refunds).values({
    id: refundId,
    orderId: snapshot.order.id,
    paymentId: payment.id,
    amountKop: plan.amountKop,
    items: plan.lines.map((line) => ({
      orderItemId: line.orderItemId,
      subject: line.subject,
      qty: line.qty,
      amountKop: line.amountKop,
    })),
    reason: input.reason,
    status: 'pending',
    scope: input.scope,
    idempotenceKey,
    request,
    requestedAt: input.requestedAt,
    deadlineAt:
      retryOf?.deadlineAt ?? new Date(input.requestedAt.getTime() + REFUND_DEADLINE_DAYS * DAY_MS),
    retryOfRefundId: retryOf?.id ?? null,
  });
  const receiptId = uuidv7();
  await tx.insert(receipts).values({
    id: receiptId,
    orderId: snapshot.order.id,
    paymentId: payment.id,
    refundId,
    kind: receiptKind,
    idempotenceKey: `${idempotenceKey}:receipt`,
    status: 'pending',
    request: receipt.data,
  });
  await enqueueOutbox(tx, {
    queue: 'payments',
    name: 'refund-create',
    key: `refund-create:${refundId}`,
    data: { refundId, orderId: snapshot.order.id },
  });
  await recordJournalEvent(tx, {
    orderId: snapshot.order.id,
    type: 'refund_created',
    actor: input.actor ?? SYSTEM_ACTOR,
    payload: {
      refundId,
      paymentId: payment.id,
      scope: input.scope,
      reason: input.reason,
      amountKop: plan.amountKop,
      receiptKind,
      ...(input.itemIds && input.itemIds.length > 0 ? { itemIds: input.itemIds } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(retryOf ? { retryOf: retryOf.id } : {}),
    },
    at: input.at ?? input.requestedAt,
  });
  return { refundId, receiptId, amountKop: plan.amountKop };
}

/** refunds.error of a refund task: money the owner has to decide about, nothing was sent. */
export const REFUND_TASK_ERROR = 'needs_owner';

/**
 * A refund task (no provider call): a payment that arrived where no rule returns it by itself
 * (after handover, a duplicate the order accepted, a status without a rule). The row is
 * `failed` with error `needs_owner` and scope `orphan`, so the 10-day reminder (deadline_at)
 * runs and the money is not forgotten; «Вернуть платёж» takes it over (retry_of). Nothing
 * when the payment has nothing left or already has an open task.
 */
export async function createRefundTask(
  tx: Tx,
  snapshot: OrderSnapshot,
  input: {
    paymentId: string;
    reason: RefundReason;
    requestedAt: Date;
    actor?: ActorRef;
    note?: string;
  },
): Promise<{ refundId: string; amountKop: Kop } | null> {
  const payment = snapshot.payments.find((p) => p.id === input.paymentId);
  if (payment === undefined) return null;
  const amountKop = paymentRestKop(snapshot, payment.id);
  if (amountKop <= 0) return null;
  const open = openRefundTasks(snapshot).some((task) => task.paymentId === payment.id);
  if (open) return null;
  const refundId = uuidv7();
  await tx.insert(refunds).values({
    id: refundId,
    orderId: snapshot.order.id,
    paymentId: payment.id,
    amountKop,
    items: [],
    reason: input.reason,
    status: 'failed',
    scope: 'orphan',
    idempotenceKey: uuidv7(),
    request: null,
    error: REFUND_TASK_ERROR,
    alertedAt: input.requestedAt,
    requestedAt: input.requestedAt,
    deadlineAt: new Date(input.requestedAt.getTime() + REFUND_DEADLINE_DAYS * DAY_MS),
  });
  await recordJournalEvent(tx, {
    orderId: snapshot.order.id,
    type: 'refund_created',
    actor: input.actor ?? SYSTEM_ACTOR,
    payload: {
      refundId,
      paymentId: payment.id,
      scope: 'orphan',
      reason: input.reason,
      amountKop,
      task: REFUND_TASK_ERROR,
      ...(input.note ? { note: input.note } : {}),
    },
    at: input.requestedAt,
  });
  return { refundId, amountKop };
}

/** Failed refunds nobody took over yet (no row has retry_of = their id). */
function notTakenOver(snapshot: OrderSnapshot): RefundRow[] {
  const taken = new Set(
    snapshot.refunds.map((r) => r.retryOfRefundId).filter((id): id is string => id !== null),
  );
  return snapshot.refunds.filter((r) => r.status === 'failed' && !taken.has(r.id));
}

/** Refund tasks (needs_owner) still open. */
export function openRefundTasks(snapshot: OrderSnapshot): RefundRow[] {
  return notTakenOver(snapshot).filter((r) => r.error === REFUND_TASK_ERROR);
}

/**
 * Failed order or item refunds that «Повторить возврат» can take over: the provider rejected or
 * canceled them, nobody retried them yet, and the same refund still plans (the item still waits
 * for its money, the order still has something to return from that payment).
 */
export function retryableRefunds(snapshot: OrderSnapshot): RefundRow[] {
  return notTakenOver(snapshot).filter((refund) => {
    if (refund.scope === 'orphan') return false;
    try {
      planRefund(snapshot, refundTargetOf(refund));
      return true;
    } catch {
      return false;
    }
  });
}

/** The latest failed orphan refund (or refund task) of a payment, not taken over yet. */
export function failedOrphanOf(snapshot: OrderSnapshot, paymentId: string): RefundRow | null {
  return (
    notTakenOver(snapshot)
      .filter((r) => r.scope === 'orphan' && r.paymentId === paymentId)
      .at(-1) ?? null
  );
}

/** The refund target a failed refund row stands for (same scope, payment and item). */
export function refundTargetOf(refund: RefundRow): RefundTarget {
  const itemIds = refund.items
    .map((line) => line.orderItemId)
    .filter((id): id is string => id !== null);
  return {
    scope: refund.scope,
    paymentId: refund.paymentId,
    ...(refund.scope === 'item' ? { itemIds: itemIds.slice(0, 1) } : {}),
  };
}

function receiptCodesFromPayment(payment: PaymentRow): ReceiptCodesOnly | null {
  const request = payment.request as StoredPaymentRequest | null;
  const vatCode = request?.receipt?.lines?.[0]?.vatCode;
  const taxSystemCode = request?.receipt?.taxSystemCode;
  return typeof vatCode === 'number' && typeof taxSystemCode === 'number'
    ? { vatCode, taxSystemCode }
    : null;
}

// ---------------------------------------------------------------------------------------------
// Offset receipt
// ---------------------------------------------------------------------------------------------

/**
 * The offset receipt of a prepay order (Б22): a new row (new key) and outbox receipts/offset
 * when the order has no offset receipt or the last one was finally rejected (canceled); a
 * pending one is only re-queued when `retryKey` is given («Повторить чек»).
 */
export async function ensureOffsetReceipt(
  tx: Tx,
  snapshot: OrderSnapshot,
  input: { env: Env; retryKey?: string | null },
): Promise<{ receiptId: string; created: boolean }> {
  const current = snapshot.receipts
    .filter((r) => r.kind === 'offset' && r.status !== 'canceled')
    .at(-1);
  if (current !== undefined) {
    if (current.status === 'pending' && input.retryKey) {
      await enqueueOutbox(tx, {
        queue: 'receipts',
        name: 'offset',
        key: `offset:${current.id}:retry:${input.retryKey}`,
        data: { receiptId: current.id, orderId: snapshot.order.id },
      });
    }
    return { receiptId: current.id, created: false };
  }
  // The order's own prepayment, the oldest held one with money left: refunds of the order are
  // taken from it too (refundablePayment), so a duplicate payment (two tabs) is never offset.
  const payment = heldPayments(snapshot).find(
    (p) =>
      p.kind === 'prepayment' && p.providerPaymentId !== null && paymentRestKop(snapshot, p.id) > 0,
  );
  if (payment === undefined) throw new EngineError('no_prepayment', 'no succeeded prepayment');
  const codes = receiptCodesFor(input.env, payment);
  if (codes === null) throw new EngineError('receipt_codes_missing');
  const phone = await requirePhone(tx, snapshot);
  const live = snapshot.items.filter((item) => isLiveState(item.state));
  const { data, prepaymentKop } = buildOffsetReceipt({
    items: live.map(receiptItemInput),
    courierFeeKop: snapshot.order.courierFeeKop,
    phone,
    vatCode: codes.vatCode,
    taxSystemCode: codes.taxSystemCode,
  });
  if (prepaymentKop > paymentRestKop(snapshot, payment.id)) {
    // The offset would consume more advance than this payment still holds (54-FZ).
    throw new EngineError(
      'offset_exceeds_prepayment',
      `offset ${prepaymentKop} exceeds the rest of the prepayment`,
    );
  }
  const receiptId = uuidv7();
  const idempotenceKey = uuidv7();
  await tx.insert(receipts).values({
    id: receiptId,
    orderId: snapshot.order.id,
    paymentId: payment.id,
    kind: 'offset',
    idempotenceKey,
    status: 'pending',
    // CreateOffsetReceiptRequest of @detaly/payments, repeated with the same key (Б22).
    request: {
      paymentId: payment.providerPaymentId,
      idempotenceKey,
      customer: data.customer,
      lines: data.lines,
      prepaymentKop,
      ...(data.taxSystemCode !== undefined ? { taxSystemCode: data.taxSystemCode } : {}),
    },
  });
  await enqueueOutbox(tx, {
    queue: 'receipts',
    name: 'offset',
    key: `offset:${receiptId}`,
    data: { receiptId, orderId: snapshot.order.id },
  });
  return { receiptId, created: true };
}
