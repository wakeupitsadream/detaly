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
import { carts, vinRequests } from './carts';
import { fitChecks } from './fit-checks';
import {
  actorType,
  fulfillment,
  messengerChannel,
  notificationChannel,
  orderItemState,
  orderStatus,
  paymentScheme,
} from './enums';
import { documentVersions, staff, users } from './people';

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
    /** Status channel the client chose at checkout (a preference; binding comes later). */
    preferredChannel: notificationChannel(),
    /** Idempotency key of the checkout form (uuid v7 rendered into it): one order per submit. */
    checkoutKey: uuid(),
    /** Cart the order was checked out from (trace only). */
    cartId: uuid().references(() => carts.id, { onDelete: 'set null' }),
    attentionReason: text(),
    confirmedAt: tstz(),
    paidAt: tstz(),
    orderedAt: tstz(),
    receivedAt: tstz(),
    handedAt: tstz(),
    completedAt: tstz(),
    cancelledAt: tstz(),
    /** «Клиент пришёл» was pressed (phase 1B): offset receipt / handover payment may start. */
    clientArrivedAt: tstz(),
    /** Payment / confirmation / pickup deadline depending on status (housekeeping). */
    expiresAt: tstz(),
    supplierReturnDeadlineAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Phase 1C: the VIN request whose proposal (/p/<token>) this order was checked out from. */
    vinRequestId: uuid().references((): AnyPgColumn => vinRequests.id, { onDelete: 'set null' }),
  },
  (t) => [
    unique('orders_number_unique').on(t.number),
    index('orders_vin_request_id_idx').on(t.vinRequestId),
    unique('orders_access_token_unique').on(t.accessToken),
    unique('orders_checkout_key_unique').on(t.checkoutKey),
    index('orders_cart_id_idx').on(t.cartId),
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
    /** Same key as cart_items.offer_key. */
    offerKey: text().notNull(),
    /** Query article the offer was found by (the 1B recheck searches with it). */
    searchArticleNorm: text().notNull(),
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
    /** «Приехало» for this item (phase 1B: partial arrival, pickup reminders). */
    arrivedAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // --- step 4 (docs/fit-check.md): copied at checkout from the cart line's fit check ---
    /** The check that said `fits` (or the analog the client accepted). */
    fitCheckId: uuid().references((): AnyPgColumn => fitChecks.id, { onDelete: 'set null' }),
    /** When the master answered. */
    fitCheckedAt: tstz(),
    /** Who answered; null for an answer from the admin. */
    fitCheckedBy: uuid().references(() => staff.id),
    /** FIT_GUARANTEE_ENABLED at checkout for a checked line: «вернём деньги» was promised. */
    fitGuarantee: boolean().notNull().default(false),
  },
  (t) => [
    index('order_items_order_id_idx').on(t.orderId),
    index('order_items_fit_check_id_idx').on(t.fitCheckId),
    namedCheck(
      'order_items',
      'fit_guarantee',
      sql`not ${t.fitGuarantee} or ${t.fitCheckedAt} is not null`,
    ),
    namedCheck(
      'order_items',
      'search_article_norm',
      sql`${t.searchArticleNorm} ~ '^[A-Z0-9]{1,64}$'`,
    ),
    namedCheck('order_items', 'qty', sql`${t.qty} > 0`),
    kopCheck('order_items', 'price_supplier_at_order_kop', t.priceSupplierAtOrderKop),
    kopCheck('order_items', 'price_client_kop', t.priceClientKop),
    kopCheck('order_items', 'refunded_amount_kop', t.refundedAmountKop),
    namedCheck('order_items', 'markup_bp', sql`${t.markupBp} >= 0`),
    namedCheck(
      'order_items',
      'refunded_amount_le_line',
      // bigint: price * qty may exceed int4 and must not turn the check into an error.
      sql`${t.refundedAmountKop}::bigint <= ${t.priceClientKop}::bigint * ${t.qty}`,
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

/**
 * One-time deep-link payload (`?start=<token>`): <= 64 chars for Telegram. Phase 1C: used once
 * (`used_at`, by `used_by_external_id`), 24 hours, never the order page token (decision С3).
 */
export const linkTokens = pgTable(
  'link_tokens',
  {
    token: text().primaryKey(),
    userId: uuid().references(() => users.id),
    orderId: uuid().references(() => orders.id),
    expiresAt: tstz().notNull(),
    usedAt: tstz(),
    createdAt: createdAt(),
    // --- phase 1C ---
    channel: messengerChannel().notNull().default('telegram'),
    /** Messenger user id that consumed the token (Telegram from.id as text). */
    usedByExternalId: text(),
  },
  (t) => [
    index('link_tokens_expires_at_idx').on(t.expiresAt),
    index('link_tokens_user_id_idx').on(t.userId),
    namedCheck('link_tokens', 'token', sql`${t.token} ~ '^[A-Za-z0-9_-]{1,64}$'`),
  ],
);
