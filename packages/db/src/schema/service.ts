// Client claims, installation bookings (no price: installation is paid at Service56) and
// order photos. Phase 1C columns: docs/phase-1c-implementation.md section 1.1.
import {
  CLAIM_DECIDED_VIA,
  CLAIM_OPENED_VIA,
  FILE_KEY_PATTERN,
  INSTALL_CREATED_VIA,
  INSTALL_HOLDING_STATUSES,
} from '@detaly/domain/statuses';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uniqueIndex, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, kop, kopCheck, namedCheck, sqlList, tstz, updatedAt } from './columns';
import { claimDecision, claimKind, installBookingStatus, photoKind } from './enums';
import { orderItems, orders } from './orders';
import { refunds } from './payments';
import { staff, users } from './people';

/** Nil uuid: a claim about the whole order in the "one open claim per target" index. */
const WHOLE_ORDER = sql.raw(`'00000000-0000-0000-0000-000000000000'::uuid`);

/**
 * deadline_at = opened_at + 10 days (CHECK, exactly 240 hours so the check does not depend on
 * the session time zone); refund only after return_accepted_at (except delay) or an owner
 * override with a reason. One open claim per order item, and one per whole order.
 */
export const claims = pgTable(
  'claims',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    /** The item the claim is about; null for the whole order. */
    orderItemId: uuid().references(() => orderItems.id),
    kind: claimKind().notNull(),
    openedAt: tstz().notNull().defaultNow(),
    deadlineAt: tstz().notNull(),
    decision: claimDecision(),
    /** Answer to the client (shown on /o/<token> only; may contain PD). */
    decisionText: text(),
    compensationAmountKop: kop(),
    returnAcceptedAt: tstz(),
    decidedBy: uuid().references(() => staff.id),
    /** FileStore keys of the client's photos (claim/<order id>/<uuid>.jpg). */
    photos: jsonb().$type<string[]>().notNull().default([]),
    closedAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // --- phase 1C ---
    /** The client's description (may contain PD: never sent to Telegram unmasked). */
    clientText: text(),
    /** 'web' | 'admin' | 'bot' (CLAIM_OPENED_VIA). */
    openedVia: text(),
    /** Idempotency key of the claim form: a repeated submit returns the same claim. */
    requestKey: uuid(),
    decidedAt: tstz(),
    /** 'bot' | 'admin' (CLAIM_DECIDED_VIA). */
    decidedVia: text(),
    /** Owner override of «Принял возврат» (refund decision only); also in order_events. */
    overrideReason: text(),
    /** The refund created by the decision. */
    refundId: uuid().references(() => refunds.id),
    /** «Замена выдана» note (no PD). */
    replacementNote: text(),
  },
  (t) => [
    index('claims_deadline_at_open_idx')
      .on(t.deadlineAt)
      .where(sql`${t.closedAt} is null`),
    index('claims_order_id_idx').on(t.orderId),
    kopCheck('claims', 'compensation_amount_kop', t.compensationAmountKop),
    unique('claims_request_key_unique').on(t.requestKey),
    uniqueIndex('claims_open_target_unique')
      .on(t.orderId, sql`coalesce(${t.orderItemId}, ${WHOLE_ORDER})`)
      .where(sql`${t.closedAt} is null`),
    namedCheck('claims', 'deadline', sql`${t.deadlineAt} = ${t.openedAt} + interval '240 hours'`),
    namedCheck(
      'claims',
      'decision_text',
      sql`${t.decision} is null or (${t.decidedAt} is not null and coalesce(length(btrim(${t.decisionText})), 0) between 1 and 2000)`,
    ),
    namedCheck(
      'claims',
      'override_reason',
      sql`${t.overrideReason} is null or (${t.decision} is not null and ${t.decision} = 'refund' and length(btrim(${t.overrideReason})) > 0)`,
    ),
    namedCheck('claims', 'client_text', sql`length(${t.clientText}) <= 1000`),
    namedCheck('claims', 'opened_via', sql`${t.openedVia} in (${sqlList(CLAIM_OPENED_VIA)})`),
    namedCheck('claims', 'decided_via', sql`${t.decidedVia} in (${sqlList(CLAIM_DECIDED_VIA)})`),
    namedCheck(
      'claims',
      'photos',
      sql`case when jsonb_typeof(${t.photos}) = 'array' then jsonb_array_length(${t.photos}) <= 3 else false end`,
    ),
  ],
);

/** Installation slot of an order. No price anywhere: the service bills the client itself. */
export const installBookings = pgTable(
  'install_bookings',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    slotAt: tstz().notNull(),
    status: installBookingStatus().notNull().default('requested'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // --- phase 1C ---
    /** Idempotency key of the booking form / bot press. */
    requestKey: uuid(),
    confirmedAt: tstz(),
    cancelledAt: tstz(),
    /** The 24-hour reminder was queued. */
    remindedAt: tstz(),
    /** 'web' | 'bot' | 'admin' (INSTALL_CREATED_VIA). */
    createdVia: text(),
    /** Note of the master (no PD). */
    staffNote: text(),
  },
  (t) => [
    index('install_bookings_slot_at_idx').on(t.slotAt),
    index('install_bookings_order_id_idx').on(t.orderId),
    unique('install_bookings_request_key_unique').on(t.requestKey),
    uniqueIndex('install_bookings_order_active_unique')
      .on(t.orderId)
      .where(sql`${t.status} in (${sqlList(INSTALL_HOLDING_STATUSES)})`),
    namedCheck(
      'install_bookings',
      'created_via',
      sql`${t.createdVia} in (${sqlList(INSTALL_CREATED_VIA)})`,
    ),
  ],
);

/** Packaging, handover and return photos; s3_key is a FileStore key (FILE_KEY_PATTERN). */
export const orderPhotos = pgTable(
  'order_photos',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    kind: photoKind().notNull(),
    s3Key: text().notNull(),
    byStaffId: uuid().references(() => staff.id),
    createdAt: createdAt(),
    // --- phase 1C ---
    /** The claim a return photo belongs to (required for kind 'return'). */
    claimId: uuid().references(() => claims.id),
    orderItemId: uuid().references(() => orderItems.id),
  },
  (t) => [
    index('order_photos_order_id_idx').on(t.orderId),
    index('order_photos_claim_id_idx').on(t.claimId),
    namedCheck(
      'order_photos',
      'return_claim',
      sql`${t.kind} <> 'return' or ${t.claimId} is not null`,
    ),
    namedCheck('order_photos', 's3_key', sql`${t.s3Key} ~ '${sql.raw(FILE_KEY_PATTERN)}'`),
  ],
);
