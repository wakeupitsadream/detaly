// Payments, 54-FZ receipts and refunds (YooKassa API v3). Rows are written before the
// provider call so Idempotence-Key is stable across retries.
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, kop, namedCheck, tstz, updatedAt } from './columns';
import {
  paymentKind,
  paymentProvider,
  paymentStatus,
  receiptKind,
  receiptStatus,
  refundReason,
  refundScope,
  refundStatus,
} from './enums';
import { orders } from './orders';

/**
 * Payments of an order. Phase 0 had a partial unique index "one succeeded payment per order";
 * phase 1B drops it (decision Б8): a real double payment must be recorded as succeeded and
 * handled by the engine (unexpected payment -> owner, orphan payment -> automatic refund).
 */
export const payments = pgTable(
  'payments',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    provider: paymentProvider().notNull().default('yookassa'),
    /** Set after POST /payments succeeds. */
    providerPaymentId: text(),
    kind: paymentKind().notNull(),
    status: paymentStatus().notNull().default('pending'),
    amountKop: kop().notNull(),
    method: text(),
    idempotenceKey: text().notNull(),
    confirmationUrl: text(),
    /** 'redirect' (link on /o/<token>) or 'qr' (seller's screen at the pickup point). */
    confirmationType: text(),
    /** QR payload for confirmation type qr; never sent to the client. */
    confirmationData: text(),
    expiresAt: tstz(),
    /**
     * Body of POST /payments (decision Б7): reconciliation repeats it with the same
     * Idempotence-Key when provider_payment_id was not recorded.
     */
    request: jsonb(),
    paidAt: tstz(),
    canceledAt: tstz(),
    /** YooKassa cancellation_details.reason as received. */
    cancellationReason: text(),
    /** Last provider object as received (GET /payments/{id}). */
    raw: jsonb(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('payments_provider_payment_id_unique').on(t.provider, t.providerPaymentId),
    unique('payments_idempotence_key_unique').on(t.idempotenceKey),
    index('payments_order_id_idx').on(t.orderId),
    index('payments_order_id_status_idx').on(t.orderId, t.status),
    index('payments_status_created_at_idx').on(t.status, t.createdAt),
    namedCheck('payments', 'amount_kop', sql`${t.amountKop} > 0`),
    namedCheck('payments', 'confirmation_type', sql`${t.confirmationType} in ('redirect', 'qr')`),
  ],
);

export const receipts = pgTable(
  'receipts',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    paymentId: uuid().references(() => payments.id),
    refundId: uuid().references(() => refunds.id),
    kind: receiptKind().notNull(),
    providerReceiptId: text(),
    idempotenceKey: text().notNull(),
    status: receiptStatus().notNull().default('pending'),
    fiscalDocumentNumber: text(),
    request: jsonb(),
    response: jsonb(),
    /** POST /receipts attempts (decision Б22: same key every 2 minutes up to 15 minutes). */
    attempts: integer().notNull().default(0),
    firstAttemptAt: tstz(),
    /** The 15-minute alert was sent («Выдал» stays blocked). */
    alertedAt: tstz(),
    /** Last error without PD (provider code and message). */
    error: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('receipts_idempotence_key_unique').on(t.idempotenceKey),
    index('receipts_order_id_idx').on(t.orderId),
    // PLAN section 2: a partial handover with several offset receipts is forbidden. A rejected
    // attempt is set to canceled before «Повторить чек» inserts a new row with a new key.
    uniqueIndex('receipts_order_offset_unique')
      .on(t.orderId)
      .where(sql`${t.kind} = 'offset' and ${t.status} <> 'canceled'`),
    // The receipt sent inside a payment: one per payment.
    uniqueIndex('receipts_payment_kind_unique')
      .on(t.paymentId, t.kind)
      .where(sql`${t.kind} in ('prepayment', 'full')`),
    namedCheck('receipts', 'attempts', sql`${t.attempts} >= 0`),
  ],
);

/** Refund line written to refunds.items (partial refunds are per order item). */
export interface RefundItem {
  orderItemId: string | null;
  /** 'service' for the courier fee line. */
  subject: 'commodity' | 'service';
  qty: number;
  amountKop: number;
}

/** deadline_at = client request + 10 days (consumer law); failed alerts, the clock keeps running. */
export const refunds = pgTable(
  'refunds',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    paymentId: uuid()
      .notNull()
      .references(() => payments.id),
    providerRefundId: text(),
    amountKop: kop().notNull(),
    items: jsonb().$type<RefundItem[]>().notNull().default([]),
    reason: refundReason().notNull(),
    status: refundStatus().notNull().default('pending'),
    /** order: the whole order (-> refunded); item: one item; orphan: payment of a refunded order. */
    scope: refundScope().notNull().default('order'),
    idempotenceKey: text().notNull(),
    /** Body of POST /refunds (decision Б7), repeated with the same key by reconciliation. */
    request: jsonb(),
    /** Last error without PD. */
    error: text(),
    /** The failure / deadline alert was sent. */
    alertedAt: tstz(),
    requestedAt: tstz().notNull(),
    deadlineAt: tstz().notNull(),
    succeededAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('refunds_idempotence_key_unique').on(t.idempotenceKey),
    unique('refunds_provider_refund_id_unique').on(t.providerRefundId),
    index('refunds_status_deadline_at_idx').on(t.status, t.deadlineAt),
    index('refunds_order_id_idx').on(t.orderId),
    index('refunds_payment_id_idx').on(t.paymentId),
    namedCheck('refunds', 'amount_kop', sql`${t.amountKop} > 0`),
  ],
);
