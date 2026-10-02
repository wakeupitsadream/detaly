// Rossko orders (one row per GetCheckout attempt, created as `sending` before the call),
// returns/claims to the supplier and our own stock of parts Rossko did not take back.
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, kop, kopCheck, namedCheck, tstz, updatedAt } from './columns';
import { supplierOrderStatus, supplierReturnKind, supplierReturnStatus } from './enums';
import { orderItems, orders } from './orders';

export const supplierOrders = pgTable(
  'supplier_orders',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    attemptNo: integer().notNull(),
    status: supplierOrderStatus().notNull().default('sending'),
    /** Rossko OrderIDS.id values. */
    rosskoOrderIds: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    request: jsonb(),
    response: jsonb(),
    /** Rossko ItemsErrorList as received. */
    itemErrors: jsonb(),
    deliveryCostKop: kop(),
    /** Rossko order status code from GetOrders (phase 2 polling). */
    statusCode: integer(),
    /**
     * UPD (universal transfer document) in S3. Explicit name: snake_case casing would turn
     * `updS3Key` into `upd_s_3_key`.
     */
    updS3Key: text('upd_s3_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('supplier_orders_order_id_attempt_no_unique').on(t.orderId, t.attemptNo),
    namedCheck('supplier_orders', 'attempt_no', sql`${t.attemptNo} >= 1`),
    kopCheck('supplier_orders', 'delivery_cost_kop', t.deliveryCostKop),
  ],
);

/** Which order items went into which supplier order (phase 4: one supplier order per day). */
export const supplierOrderItems = pgTable(
  'supplier_order_items',
  {
    supplierOrderId: uuid()
      .notNull()
      .references(() => supplierOrders.id, { onDelete: 'cascade' }),
    orderItemId: uuid()
      .notNull()
      .references(() => orderItems.id),
  },
  (t) => [
    primaryKey({ columns: [t.supplierOrderId, t.orderItemId] }),
    index('supplier_order_items_order_item_id_idx').on(t.orderItemId),
  ],
);

/** Return or claim to Rossko; does not affect the client order status. */
export const supplierReturns = pgTable(
  'supplier_returns',
  {
    id: id(),
    orderItemId: uuid()
      .notNull()
      .references(() => orderItems.id),
    kind: supplierReturnKind().notNull(),
    status: supplierReturnStatus().notNull().default('requested'),
    amountExpectedKop: kop(),
    amountReceivedKop: kop(),
    note: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('supplier_returns_order_item_id_idx').on(t.orderItemId),
    kopCheck('supplier_returns', 'amount_expected_kop', t.amountExpectedKop),
    kopCheck('supplier_returns', 'amount_received_kop', t.amountReceivedKop),
  ],
);

/** Parts Rossko did not accept back ("sell from stock" is phase 2). */
export const stockItems = pgTable(
  'stock_items',
  {
    id: id(),
    orderItemId: uuid()
      .notNull()
      .references(() => orderItems.id),
    costKop: kop().notNull(),
    reason: text().notNull(),
    listedPriceKop: kop(),
    writtenOffAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('stock_items_order_item_id_idx').on(t.orderItemId),
    kopCheck('stock_items', 'cost_kop', t.costKop),
    kopCheck('stock_items', 'listed_price_kop', t.listedPriceKop),
  ],
);
