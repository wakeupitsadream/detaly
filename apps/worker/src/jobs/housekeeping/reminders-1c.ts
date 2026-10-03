// Phase 1C reminders of housekeeping/reminders (docs/phase-1c-implementation.md section 7.3,
// decisions С7, С6, С15). Each one is written once: an outbox key queued before is never queued
// again, and the row's reminded_at (VIN, booking) keeps it out of the next scans.
//
// | kind           | when                                                       | to      | job                              |
// | vin            | 4 h without an answer (new / in_work, no proposal sent);   | sellers | notify/vin card «Без ответа 4 ч» |
// |                | outside PICKUP_HOURS the job waits for the opening         |         | key reminder:vin:<id>:4h         |
// | claim_deadline | 2 days before claims.deadline_at, no decision yet          | owner   | staff_claim_deadline             |
// |                |                                                            |         | key reminder:<order>:claim:<id>  |
// | install        | 24 h before a confirmed slot                               | client  | install_reminder                 |
// |                |                                                            |         | key reminder:<order>:install:<id>|
import { NOTIFY_JOBS } from '@detaly/config';
import {
  and,
  asc,
  claims,
  eq,
  gt,
  inArray,
  installBookings,
  isNull,
  orders,
  sql,
  vinRequests,
} from '@detaly/db';
import { localDate, TIMERS, VIN_OPEN_STATUSES, type OrderStatus } from '@detaly/domain';
import { enqueueOutbox } from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import type { NotifyVinJobData } from '../notify/vin';
import { BATCH, notAfter, queueReminder } from './common';
import { nextOpeningAt } from './opening';

/** The extra line of the repeated VIN card (no PD). */
export const VIN_REMINDER_NOTE = 'Без ответа 4 ч';

/** Orders whose installation will not happen: no reminder of a booking left behind. */
const CLOSED_ORDER_STATUSES: readonly OrderStatus[] = ['cancelled', 'refund_pending', 'refunded'];

export async function runReminders1c(
  deps: WorkerDeps,
  now: Date,
  add: (kind: string, queued: boolean) => void,
): Promise<void> {
  const nowMs = now.getTime();

  // vin: the request card again, once, 4 hours after the request (in the opening hours).
  const vin = await deps.db
    .select({ id: vinRequests.id })
    .from(vinRequests)
    .where(
      and(
        inArray(vinRequests.status, [...VIN_OPEN_STATUSES]),
        isNull(vinRequests.remindedAt),
        eq(vinRequests.proposalCount, 0),
        notAfter(vinRequests.createdAt, new Date(nowMs - TIMERS.vinAnswerReminderMs)),
      ),
    )
    .orderBy(asc(vinRequests.createdAt))
    .limit(BATCH);
  for (const request of vin) add('vin', await queueVinReminder(deps, request.id, now));

  // claim_deadline: the owner, 2 days before the 10-day answer deadline (art. 22 ЗоЗПП).
  const open = await deps.db
    .select({ id: claims.id, orderId: claims.orderId, deadlineAt: claims.deadlineAt })
    .from(claims)
    .where(
      and(
        isNull(claims.closedAt),
        isNull(claims.decision),
        notAfter(claims.deadlineAt, new Date(nowMs + TIMERS.claimDeadlineWarnMs)),
      ),
    )
    .orderBy(asc(claims.deadlineAt))
    .limit(BATCH);
  for (const claim of open) {
    add(
      'claim_deadline',
      await queueReminder(deps, {
        orderId: claim.orderId,
        kind: 'claim',
        n: claim.id,
        audience: 'owner',
        template: 'staff_claim_deadline',
        extras: { deadlineDate: localDate(claim.deadlineAt) },
        payload: { claimId: claim.id },
      }),
    );
  }

  // install: the client, 24 hours before a confirmed slot.
  const bookings = await deps.db
    .select({ id: installBookings.id, orderId: installBookings.orderId })
    .from(installBookings)
    .innerJoin(orders, eq(orders.id, installBookings.orderId))
    .where(
      and(
        eq(installBookings.status, 'confirmed'),
        isNull(installBookings.remindedAt),
        gt(installBookings.slotAt, now),
        notAfter(installBookings.slotAt, new Date(nowMs + TIMERS.installReminderBeforeMs)),
        sql`not (${inArray(orders.status, [...CLOSED_ORDER_STATUSES])})`,
      ),
    )
    .orderBy(asc(installBookings.slotAt))
    .limit(BATCH);
  for (const booking of bookings) {
    add(
      'install',
      await queueReminder(deps, {
        orderId: booking.orderId,
        kind: 'install',
        n: booking.id,
        audience: 'client',
        template: 'install_reminder',
        // notify/order reads the slot of this booking (template-data, payload.bookingId).
        payload: { bookingId: booking.id },
        inTx: async (tx) => {
          await tx
            .update(installBookings)
            .set({ remindedAt: now, updatedAt: now })
            .where(eq(installBookings.id, booking.id));
        },
      }),
    );
  }
}

/**
 * The 4-hour VIN reminder: outbox notify/vin (sellers card with the note) under the request row
 * lock, available at the next opening of the point, and vin_requests.reminded_at — in one
 * transaction. false when it was queued before or the request got an answer meanwhile.
 */
async function queueVinReminder(
  deps: WorkerDeps,
  vinRequestId: string,
  now: Date,
): Promise<boolean> {
  const key = `reminder:vin:${vinRequestId}:4h`;
  return deps.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: vinRequests.id })
      .from(vinRequests)
      .where(
        and(
          eq(vinRequests.id, vinRequestId),
          isNull(vinRequests.remindedAt),
          inArray(vinRequests.status, [...VIN_OPEN_STATUSES]),
        ),
      )
      .for('update');
    if (!locked) return false;
    const data: NotifyVinJobData = {
      vinRequestId,
      audience: 'sellers',
      key,
      n: 1,
      note: VIN_REMINDER_NOTE,
      reminder: true,
    };
    const queued = await enqueueOutbox(tx, {
      queue: 'notify',
      name: NOTIFY_JOBS.vin,
      key,
      data: data as unknown as Record<string, unknown>,
      availableAt: nextOpeningAt(now, deps.env.PICKUP_HOURS),
    });
    await tx
      .update(vinRequests)
      .set({ remindedAt: now, updatedAt: now })
      .where(eq(vinRequests.id, vinRequestId));
    return queued;
  });
}
