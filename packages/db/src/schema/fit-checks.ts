// Step 4 (docs/fit-check.md): «Проверим, подойдёт ли» — the master checks cart lines by VIN.
import { FIT_CHECK_ANSWERS, FIT_CHECK_STATUSES } from '@detaly/domain/statuses';
import type { Offer } from '@detaly/domain/types';
import { sql } from 'drizzle-orm';
import { char, index, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { cartItems, carts } from './carts';
import { createdAt, id, namedCheck, sqlList, tstz } from './columns';
import { staff } from './people';

/**
 * One cart line sent to the master with the VIN of the car; the lines sent together share
 * `request_id` (one sellers card per request). `brand`, `article`, `name` are the snapshot of the
 * line: a line changed after the check (another offer) no longer matches it and loses the check.
 * The master's answer: `fits`, `analog` (the analog_* columns and the supplier offer it was
 * priced from), `not_fit`, `call_needed`; nobody answered in 24 hours — `expired` (expires_at);
 * the line left the cart first — `cancelled`.
 *
 * `cart_item_id` is nulled, not cascaded, when the line is deleted: checkout removes the
 * checked-out lines from the cart in the order transaction, and order_items.fit_check_id must
 * keep pointing here (the admin statistics count checked lines in paid orders). The cart itself
 * cascades. `vin` and `comment` are cleared after FIT_CHECK_RETENTION_DAYS (90).
 */
export const fitChecks = pgTable(
  'fit_checks',
  {
    id: id(),
    cartId: uuid()
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    cartItemId: uuid().references(() => cartItems.id, { onDelete: 'set null' }),
    /** The lines sent together (one form submit): one sellers card. */
    requestId: uuid().notNull(),
    /** Null after the retention period. */
    vin: char({ length: 17 }),
    /** «Комментарий для мастера» (≤ 200), null when empty or after the retention period. */
    comment: text(),
    brand: text().notNull(),
    article: text().notNull(),
    name: text().notNull(),
    /** FIT_CHECK_STATUSES. */
    status: text().notNull().default('pending'),
    analogBrand: text(),
    analogArticle: text(),
    analogName: text(),
    /** The supplier offer the analog was found and priced from (never shown as is). */
    analogOffer: jsonb().$type<Offer>(),
    /** The client pressed «Оставить как есть» on the analog. */
    analogKeptAt: tstz(),
    /** The staff member who answered; null for an answer from the admin (Basic auth). */
    answeredBy: uuid().references(() => staff.id),
    answeredAt: tstz(),
    createdAt: createdAt(),
    expiresAt: tstz().notNull(),
  },
  (t) => [
    index('fit_checks_cart_id_created_at_idx').on(t.cartId, t.createdAt),
    index('fit_checks_cart_item_id_idx').on(t.cartItemId),
    index('fit_checks_request_id_idx').on(t.requestId),
    index('fit_checks_created_at_idx').on(t.createdAt),
    index('fit_checks_pending_created_at_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    unique('fit_checks_request_id_cart_item_id_unique').on(t.requestId, t.cartItemId),
    namedCheck('fit_checks', 'status', sql`${t.status} in (${sqlList(FIT_CHECK_STATUSES)})`),
    namedCheck('fit_checks', 'vin', sql`${t.vin} is null or ${t.vin} ~ '^[A-HJ-NPR-Z0-9]{17}$'`),
    namedCheck(
      'fit_checks',
      'comment',
      sql`${t.comment} is null or length(${t.comment}) between 1 and 200`,
    ),
    namedCheck(
      'fit_checks',
      'part',
      sql`length(btrim(${t.brand})) > 0 and length(btrim(${t.article})) > 0`,
    ),
    namedCheck(
      'fit_checks',
      'answer',
      // `is not null` spelled out: a comparison with NULL is NULL, which a CHECK lets through.
      sql`(${t.answeredAt} is not null) = (${t.status} in (${sqlList(FIT_CHECK_ANSWERS)})) and (${t.answeredBy} is null or ${t.answeredAt} is not null)`,
    ),
    namedCheck(
      'fit_checks',
      'analog',
      sql`(${t.status} = 'analog') = (${t.analogBrand} is not null) and (${t.analogBrand} is null) = (${t.analogArticle} is null) and (${t.analogBrand} is null) = (${t.analogName} is null) and (${t.analogBrand} is null) = (${t.analogOffer} is null)`,
    ),
    namedCheck(
      'fit_checks',
      'analog_kept',
      sql`${t.analogKeptAt} is null or ${t.status} = 'analog'`,
    ),
    namedCheck('fit_checks', 'expires_at', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
