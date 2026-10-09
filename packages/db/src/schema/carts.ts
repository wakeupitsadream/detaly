// Client carts, seller proposals (VIN selection) and VIN requests.
// carts.vin_request_id <-> vin_requests.proposal_cart_id form a cycle, hence AnyPgColumn.
import { VIN_OPEN_STATUSES } from '@detaly/domain/statuses';
import type { Offer, VinPreview } from '@detaly/domain/types';
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
import { createdAt, id, kop, kopCheck, namedCheck, sqlList, tstz, updatedAt } from './columns';
import { cartStatus, notificationChannel, vinProvider, vinRequestStatus } from './enums';
import { kits } from './kits';
import { orders } from './orders';
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
    /** Phase 1C: a proposal can be checked out until this moment (PROPOSAL_TTL_DAYS). */
    proposalExpiresAt: tstz(),
    // --- step 6 (docs/garage.md): what the «Моя машина» block of the checkout is filled from ---
    /** The published kit «Весь набор в корзину» last filled this cart from (GARAGE_ENABLED). */
    kitId: uuid().references((): AnyPgColumn => kits.id, { onDelete: 'set null' }),
    /**
     * «Купить снова» of the client bot: the order a repeat proposal repeats; copied into the
     * client's cart with the proposal (copyProposalToCart), like vin_request_id.
     */
    repeatOrderId: uuid().references((): AnyPgColumn => orders.id, { onDelete: 'set null' }),
  },
  (t) => [
    unique('carts_anon_token_unique').on(t.anonToken),
    unique('carts_proposal_token_unique').on(t.proposalToken),
    index('carts_user_id_idx').on(t.userId),
    index('carts_kit_id_idx')
      .on(t.kitId)
      .where(sql`${t.kitId} is not null`),
    index('carts_repeat_order_id_idx')
      .on(t.repeatOrderId)
      .where(sql`${t.repeatOrderId} is not null`),
    namedCheck(
      'carts',
      'proposal_expires_at',
      sql`(${t.proposalToken} is null) = (${t.proposalExpiresAt} is null)`,
    ),
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
    /** offerViewId(offer) = `${articleNorm}:${brand}:${stockId}`; one line per offer and cart. */
    offerKey: text().notNull(),
    /**
     * Normalized article of the search query that found the offer: repricing searches by it, so
     * a cross (W 712/75 found by OC90) is looked up with OC90 again.
     */
    searchArticleNorm: text().notNull(),
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
    unique('cart_items_cart_id_offer_key_unique').on(t.cartId, t.offerKey),
    namedCheck(
      'cart_items',
      'search_article_norm',
      sql`${t.searchArticleNorm} ~ '^[A-Z0-9]{1,64}$'`,
    ),
    namedCheck('cart_items', 'qty', sql`${t.qty} > 0`),
    kopCheck('cart_items', 'price_supplier_kop', t.priceSupplierKop),
    kopCheck('cart_items', 'price_client_kop', t.priceClientKop),
    namedCheck('cart_items', 'markup_bp', sql`${t.markupBp} >= 0`),
  ],
);

/**
 * Manual VIN selection request (phase 1C); photos are FileStore keys (vin/<id>/<uuid>.jpg),
 * at most 3, deleted after 90 days (photos_deleted_at). preview/answer_text keep the master's
 * last answer checked by GetSearch; proposal_count numbers the proposals sent.
 */
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
    // --- phase 1C ---
    /** The answer channel the client chose (telegram / sms; max in phase 2). */
    channel: notificationChannel(),
    /** Idempotency key of the form: a repeated submit returns the same request. */
    requestKey: uuid(),
    /** The master's answer as typed («БРЕНД АРТИКУЛ [КОЛ-ВО] [# заметка]» lines). */
    answerText: text(),
    preview: jsonb().$type<VinPreview>(),
    answeredAt: tstz(),
    /** The 4-hour «без ответа» reminder was queued. */
    remindedAt: tstz(),
    photosDeletedAt: tstz(),
    closedAt: tstz(),
    closeReason: text(),
    proposalCount: integer().notNull().default(0),
  },
  (t) => [
    index('vin_requests_status_created_at_idx').on(t.status, t.createdAt),
    index('vin_requests_open_created_at_idx')
      .on(t.createdAt)
      .where(sql`${t.status} in (${sqlList(VIN_OPEN_STATUSES)})`),
    unique('vin_requests_request_key_unique').on(t.requestKey),
    namedCheck('vin_requests', 'vin', sql`${t.vin} ~ '^[A-HJ-NPR-Z0-9]{17}$'`),
    namedCheck(
      'vin_requests',
      'photos',
      sql`case when jsonb_typeof(${t.photos}) = 'array' then jsonb_array_length(${t.photos}) <= 3 else false end`,
    ),
    namedCheck('vin_requests', 'proposal_count', sql`${t.proposalCount} >= 0`),
  ],
);
