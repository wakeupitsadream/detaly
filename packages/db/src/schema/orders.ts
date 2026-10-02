// Orders, order items, the order event journal and deep-link tokens.
// Status changes go only through transition() inside a transaction with a row lock.
import type { Offer } from '@detaly/domain/types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, id, kop, kopCheck, namedCheck, tstz, updatedAt } from './columns';
import { actorType, fulfillment, orderItemState, orderStatus, paymentScheme } from './enums';
import { documentVersions, users } from './people';

/**
 * Human order number DT-000001. maxValue keeps lpad() from truncating 7-digit values into
 * duplicates: at 999 999 orders nextval() fails loudly instead.
 */
export const orderNumberSeq = pgSequence('order_number_seq', {
  startWith: 1,
  minValue: 1,
  maxValue: 999_999,
  increment: 1,
  cache: 1,
  cycle: false,
});

/** Delivery address for courier orders (phase 2). */
export interface OrderAddress {
  text: string;
  entrance?: string;
  floor?: string;
  apartment?: string;
  comment?: string;
}

export const orders = pgTable(
  'orders',
  {
    id: id(),
    number: text()
      .notNull()
      .default(sql`('DT-' || lpad(nextval('order_number_seq')::text, 6, '0'))`),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** Secret for /o/<token> (>= 128 bits). */
    accessToken: text().notNull(),
    status: orderStatus().notNull().default('draft'),
    paymentScheme: paymentScheme().notNull(),
    fulfillment: fulfillment().notNull().default('pickup'),
    address: jsonb().$type<OrderAddress>(),
    subtotalKop: kop().notNull(),
    courierFeeKop: kop().notNull().default(0),
    totalKop: kop().notNull(),
    /** Hash of the priced items accepted at POST /checkout (409 on mismatch). */
    itemsHash: text().notNull(),
    promisedDate: date({ mode: 'string' }),
    pickupCode: text(),
    /** Offer (document_versions kind=offer) accepted with this order. */
    offerVersionId: uuid().references(() => documentVersions.id),
    attentionReason: text(),
    confirmedAt: tstz(),
    paidAt: tstz(),
    orderedAt: tstz(),
    receivedAt: tstz(),
    handedAt: tstz(),
    completedAt: tstz(),
    cancelledAt: tstz(),
    /** Payment / confirmation / pickup deadline depending on status (housekeeping). */
    expiresAt: tstz(),
    supplierReturnDeadlineAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('orders_number_unique').on(t.number),
    unique('orders_access_token_unique').on(t.accessToken),
    index('orders_status_expires_at_idx').on(t.status, t.expiresAt),
    index('orders_user_id_idx').on(t.userId),
    kopCheck('orders', 'subtotal_kop', t.subtotalKop),
    kopCheck('orders', 'courier_fee_kop', t.courierFeeKop),
    kopCheck('orders', 'total_kop', t.totalKop),
    namedCheck('orders', 'total', sql`${t.totalKop} = ${t.subtotalKop} + ${t.courierFeeKop}`),
    namedCheck('orders', 'number', sql`${t.number} ~ '^DT-[0-9]{6}$'`),
  ],
);

/** Per-item state: partial arrival, partial refunds, replacements (replaced_by_item_id). */
export const orderItems = pgTable(
  'order_items',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    brand: text().notNull(),
    article: text().notNull(),
    name: text().notNull(),
    qty: integer().notNull(),
    stockId: text().notNull(),
    isLocal: boolean().notNull(),
    priceSupplierAtOrderKop: kop().notNull(),
    priceClientKop: kop().notNull(),
    markupBp: integer().notNull(),
    etaDate: date({ mode: 'string' }),
    offerSnapshot: jsonb().$type<Offer>().notNull(),
    state: orderItemState().notNull().default('pending'),
    replacedByItemId: uuid().references((): AnyPgColumn => orderItems.id),
    /** Rossko ItemsErrorList entry for this item, as received. */
    supplierItemError: jsonb(),
    /** Chestny Znak marking code (marked goods are excluded at start). */
    markingCode: text(),
    refundedAmountKop: kop().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('order_items_order_id_idx').on(t.orderId),
    namedCheck('order_items', 'qty', sql`${t.qty} > 0`),
    kopCheck('order_items', 'price_supplier_at_order_kop', t.priceSupplierAtOrderKop),
    kopCheck('order_items', 'price_client_kop', t.priceClientKop),
    kopCheck('order_items', 'refunded_amount_kop', t.refundedAmountKop),
    namedCheck('order_items', 'markup_bp', sql`${t.markupBp} >= 0`),
    namedCheck(
      'order_items',
      'refunded_amount_le_line',
      sql`${t.refundedAmountKop} <= ${t.priceClientKop} * ${t.qty}`,
    ),
  ],
);

/** Full journal: client timeline, disputes, the monthly act. `type` is a state-machine event. */
export const orderEvents = pgTable(
  'order_events',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    type: text().notNull(),
    fromStatus: orderStatus(),
    toStatus: orderStatus(),
    actorType: actorType().notNull(),
    /** staff id, user id or an external identifier (e.g. 'yookassa'). */
    actorId: text(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('order_events_order_id_created_at_idx').on(t.orderId, t.createdAt)],
);

/** One-time deep-link payload (`?start=<token>`): <= 64 chars for Telegram. */
export const linkTokens = pgTable(
  'link_tokens',
  {
    token: text().primaryKey(),
    userId: uuid().references(() => users.id),
    orderId: uuid().references(() => orders.id),
    expiresAt: tstz().notNull(),
    usedAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [
    index('link_tokens_expires_at_idx').on(t.expiresAt),
    namedCheck('link_tokens', 'token', sql`${t.token} ~ '^[A-Za-z0-9_-]{1,64}$'`),
  ],
);
