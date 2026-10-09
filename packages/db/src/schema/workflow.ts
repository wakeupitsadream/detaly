// Phase 1B tables (docs/phase-1b-implementation.md section 1.1): the transactional outbox,
// client approvals and seller bot cards (VIN request cards since phase 1C).
import { SELLER_CARD_KINDS } from '@detaly/domain/statuses';
import type { ApprovalProposal } from '@detaly/domain/types';
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
import { vinRequests } from './carts';
import { createdAt, id, namedCheck, sqlList, tstz, updatedAt } from './columns';
import { approvalDecision, approvalKind } from './enums';
import { orderEvents, orderItems, orders } from './orders';
import { staff } from './people';

/**
 * Queues an outbox row may target: QUEUE_NAMES of @detaly/config without dead-letter (the
 * schema does not import config; packages/db/test/phase1b.int.test.ts compares the lists).
 */
export const OUTBOX_QUEUE_NAMES = [
  'payments',
  'receipts',
  'rossko',
  'notify',
  'reconciliation',
  'housekeeping',
] as const;

/**
 * Transactional outbox (decisions Б1–Б3). Effects of a transition (notifications, payments,
 * refunds, receipts, GetCheckout) are written here in the transaction of the transition; the
 * worker's dispatcher moves pending rows to BullMQ (`for update skip locked`) with
 * jobId = bullJobId(job_id). job_id is the logical key in PLAN format and is unique: enqueueing
 * the same key twice is a no-op.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: id(),
    queue: text().notNull(),
    /** Job name within the queue. */
    name: text().notNull(),
    /** Logical job key (`payment.succeeded:<object.id>`, `checkout:<supplier_order_id>`, ...). */
    jobId: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Not dispatched before this moment (delayed effects, reminders). */
    availableAt: tstz().notNull().defaultNow(),
    dispatchedAt: tstz(),
    /** Failed dispatch attempts (Redis unavailable); the row stays pending. */
    attempts: integer().notNull().default(0),
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('outbox_job_id_unique').on(t.jobId),
    index('outbox_pending_idx')
      .on(t.availableAt)
      .where(sql`${t.dispatchedAt} is null`),
    namedCheck(
      'outbox',
      'queue',
      sql`${t.queue} in (${sql.join(
        OUTBOX_QUEUE_NAMES.map((name) => sql.raw(`'${name}'`)),
        sql`, `,
      )})`,
    ),
    namedCheck('outbox', 'attempts', sql`${t.attempts} >= 0`),
  ],
);

/**
 * A question to the client (decision Б16): an alternative at the client's price or a new date,
 * for the whole order or one item. At most one open (undecided) approval per order. The 24-hour
 * timer (expires_at) starts only when decision_needed was actually sent (notified_at).
 */
export const clientApprovals = pgTable(
  'client_approvals',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    /** Set for scope 'item'. */
    orderItemId: uuid().references(() => orderItems.id),
    kind: approvalKind().notNull(),
    /** 'order' | 'item' (APPROVAL_SCOPES). */
    scope: text().notNull(),
    proposal: jsonb().$type<ApprovalProposal>().notNull(),
    createdByStaffId: uuid().references(() => staff.id),
    notifiedAt: tstz(),
    expiresAt: tstz(),
    remindedAt: tstz(),
    decidedAt: tstz(),
    decision: approvalDecision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('client_approvals_order_open_unique')
      .on(t.orderId)
      .where(sql`${t.decidedAt} is null`),
    index('client_approvals_expires_at_open_idx')
      .on(t.expiresAt)
      .where(sql`${t.decidedAt} is null`),
    namedCheck('client_approvals', 'scope', sql`${t.scope} in ('order', 'item')`),
    namedCheck(
      'client_approvals',
      'scope_item',
      sql`(${t.scope} = 'item') = (${t.orderItemId} is not null)`,
    ),
    namedCheck(
      'client_approvals',
      'decision',
      sql`(${t.decidedAt} is null) = (${t.decision} is null)`,
    ),
  ],
);

/**
 * Seller bot cards (decision Б17): one Telegram message per card, one nonce per card. A button
 * press must carry the nonce of an open card (`a:<action>:<id>:<nonce>`); the pressed card is
 * edited and older open cards of the order are closed. Phase 1C: a card belongs to exactly one
 * owner, an order (kinds order, qr) or a VIN request (kind vin). Step 4 (docs/fit-check.md): or a
 * fit check request (kind fit, fit_request_id = fit_checks.request_id; there is no request table,
 * so no foreign key).
 */
export const sellerCards = pgTable(
  'seller_cards',
  {
    id: id(),
    /** Null for a VIN request card (phase 1C). */
    orderId: uuid().references(() => orders.id),
    /** Phase 1C: the VIN request of a `vin` card. */
    vinRequestId: uuid().references(() => vinRequests.id),
    /** Set for an item menu card. */
    orderItemId: uuid().references(() => orderItems.id),
    chatId: text().notNull(),
    /** Telegram message id; null until Telegram answered. */
    messageId: integer(),
    /** 8 characters of base64url. */
    nonce: text().notNull(),
    /** 'order' | 'qr' | 'vin' (SELLER_CARD_KINDS). */
    kind: text().notNull(),
    orderEventId: uuid().references(() => orderEvents.id),
    createdAt: createdAt(),
    closedAt: tstz(),
    /** Step 4: the fit check request of a `fit` card (fit_checks.request_id). */
    fitRequestId: uuid(),
  },
  (t) => [
    unique('seller_cards_nonce_unique').on(t.nonce),
    index('seller_cards_order_id_open_idx')
      .on(t.orderId)
      .where(sql`${t.closedAt} is null`),
    index('seller_cards_vin_request_id_open_idx')
      .on(t.vinRequestId)
      .where(sql`${t.closedAt} is null`),
    index('seller_cards_fit_request_id_open_idx')
      .on(t.fitRequestId)
      .where(sql`${t.closedAt} is null`),
    namedCheck('seller_cards', 'nonce', sql`${t.nonce} ~ '^[A-Za-z0-9_-]{8}$'`),
    namedCheck('seller_cards', 'kind', sql`${t.kind} in (${sqlList(SELLER_CARD_KINDS)})`),
    namedCheck(
      'seller_cards',
      'owner',
      sql`num_nonnulls(${t.orderId}, ${t.vinRequestId}, ${t.fitRequestId}) = 1`,
    ),
    namedCheck(
      'seller_cards',
      'vin_owner',
      sql`(${t.kind} = 'vin') = (${t.vinRequestId} is not null)`,
    ),
    namedCheck(
      'seller_cards',
      'fit_owner',
      sql`(${t.kind} = 'fit') = (${t.fitRequestId} is not null)`,
    ),
  ],
);
