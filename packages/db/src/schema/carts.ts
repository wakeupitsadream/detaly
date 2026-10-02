// Client carts, seller proposals (VIN selection) and VIN requests.
// carts.vin_request_id <-> vin_requests.proposal_cart_id form a cycle, hence AnyPgColumn.
import type { Offer } from '@detaly/domain/types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, id, kop, kopCheck, namedCheck, tstz, updatedAt } from './columns';
import { cartStatus, vinProvider, vinRequestStatus } from './enums';
import { staff, users } from './people';

/**
 * A client cart (anon_token cookie, later user_id) or a seller proposal for a VIN request
 * (proposal_token, shown at /p/<token>).
 */
export const carts = pgTable(
  'carts',
  {
    id: id(),
    userId: uuid().references(() => users.id),
    anonToken: text(),
    status: cartStatus().notNull().default('active'),
    proposalToken: text(),
    sellerNote: text(),
    vinRequestId: uuid().references((): AnyPgColumn => vinRequests.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('carts_anon_token_unique').on(t.anonToken),
    unique('carts_proposal_token_unique').on(t.proposalToken),
    index('carts_user_id_idx').on(t.userId),
  ],
);

/** One offer in a cart with its price snapshot (recomputed on cart open and at checkout). */
export const cartItems = pgTable(
  'cart_items',
  {
    id: id(),
    cartId: uuid()
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    brand: text().notNull(),
    article: text().notNull(),
    name: text().notNull(),
    qty: integer().notNull(),
    stockId: text().notNull(),
    isLocal: boolean().notNull(),
    etaDate: date({ mode: 'string' }),
    priceSupplierKop: kop().notNull(),
    priceClientKop: kop().notNull(),
    markupBp: integer().notNull(),
    offerSnapshot: jsonb().$type<Offer>().notNull(),
    fetchedAt: tstz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('cart_items_cart_id_idx').on(t.cartId),
    namedCheck('cart_items', 'qty', sql`${t.qty} > 0`),
    kopCheck('cart_items', 'price_supplier_kop', t.priceSupplierKop),
    kopCheck('cart_items', 'price_client_kop', t.priceClientKop),
    namedCheck('cart_items', 'markup_bp', sql`${t.markupBp} >= 0`),
  ],
);

/** Manual VIN selection request (phase 1C); photos are S3 keys, auto-deleted after 90 days. */
export const vinRequests = pgTable(
  'vin_requests',
  {
    id: id(),
    userId: uuid().references(() => users.id),
    phone: text().notNull(),
    vin: char({ length: 17 }),
    carText: text(),
    needText: text().notNull(),
    photos: jsonb().$type<string[]>().notNull().default([]),
    status: vinRequestStatus().notNull().default('new'),
    assignedStaffId: uuid().references(() => staff.id),
    proposalCartId: uuid().references((): AnyPgColumn => carts.id, { onDelete: 'set null' }),
    resolver: vinProvider().notNull().default('manual'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('vin_requests_status_created_at_idx').on(t.status, t.createdAt),
    namedCheck('vin_requests', 'vin', sql`${t.vin} ~ '^[A-HJ-NPR-Z0-9]{17}$'`),
  ],
);
