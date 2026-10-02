// Payments, 54-FZ receipts and refunds (YooKassa API v3). Rows are written before the
// provider call so Idempotence-Key is stable across retries.
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, kop, namedCheck, tstz, updatedAt } from './columns';
import {
  paymentKind,
  paymentProvider,
  paymentStatus,
  receiptKind,
  receiptStatus,
  refundReason,
  refundStatus,
} from './enums';
import { orders } from './orders';

/** One order has at most one succeeded payment (partial unique index). */
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
    expiresAt: tstz(),
    /** Last provider object as received (GET /payments/{id}). */
    raw: jsonb(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('payments_provider_payment_id_unique').on(t.provider, t.providerPaymentId),
    unique('payments_idempotence_key_unique').on(t.idempotenceKey),
    uniqueIndex('payments_order_id_succeeded_unique')
      .on(t.orderId)
      .where(sql`${t.status} = 'succeeded'`),
    index('payments_order_id_idx').on(t.orderId),
    index('payments_status_created_at_idx').on(t.status, t.createdAt),
    namedCheck('payments', 'amount_kop', sql`${t.amountKop} > 0`),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('receipts_idempotence_key_unique').on(t.idempotenceKey),
    index('receipts_order_id_idx').on(t.orderId),
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
    idempotenceKey: text().notNull(),
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
    namedCheck('refunds', 'amount_kop', sql`${t.amountKop} > 0`),
  ],
);
