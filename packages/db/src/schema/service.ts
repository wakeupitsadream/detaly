// Client claims, installation bookings (no price: installation is paid at Service56) and
// order photos.
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, kop, kopCheck, tstz, updatedAt } from './columns';
import { claimDecision, claimKind, installBookingStatus, photoKind } from './enums';
import { orderItems, orders } from './orders';
import { staff, users } from './people';

/** deadline_at = opened_at + 10 days; refund only after return_accepted_at (except delay). */
export const claims = pgTable(
  'claims',
  {
    id: id(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id),
    orderItemId: uuid().references(() => orderItems.id),
    kind: claimKind().notNull(),
    openedAt: tstz().notNull().defaultNow(),
    deadlineAt: tstz().notNull(),
    decision: claimDecision(),
    decisionText: text(),
    compensationAmountKop: kop(),
    returnAcceptedAt: tstz(),
    decidedBy: uuid().references(() => staff.id),
    /** S3 keys. */
    photos: jsonb().$type<string[]>().notNull().default([]),
    closedAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('claims_deadline_at_open_idx')
      .on(t.deadlineAt)
      .where(sql`${t.closedAt} is null`),
    index('claims_order_id_idx').on(t.orderId),
    kopCheck('claims', 'compensation_amount_kop', t.compensationAmountKop),
  ],
);

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
  },
  (t) => [
    index('install_bookings_slot_at_idx').on(t.slotAt),
    index('install_bookings_order_id_idx').on(t.orderId),
  ],
);

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
  },
  (t) => [index('order_photos_order_id_idx').on(t.orderId)],
);
