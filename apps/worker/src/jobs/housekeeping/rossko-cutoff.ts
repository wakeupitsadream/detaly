// housekeeping/rossko-cutoff, every 5 minutes (step 8, docs/rossko-automation.md): the Rossko
// manager's order deadlines of settings rossko.cutoff_times ([] until known: nothing happens).
// From 25 minutes before a cutoff on a working day of the pickup point (PICKUP_HOURS) until the
// cutoff itself, when orders still wait to be ordered, the sellers chat gets one push «Через 25
// минут отсечка Rossko (11:00): не заказано N заказов» (a run that came late says the minutes
// actually left). The notify/alert outbox key `alert:rossko-cutoff:<date>:<HH:MM>` is queued once
// per cutoff and day.
//
// «Не заказано» counts the orders the supplier has not got yet: `confirmed` ones (nobody pressed
// «Проверить и заказать») and `needs_attention` ones with a live item still `pending` (the
// recheck found a problem, or GetCheckout is off and the order waits for the Rossko cabinet).
import { NOTIFY_JOBS } from '@detaly/config';
import { and, eq, inArray, orderItems, orders, sql } from '@detaly/db';
import {
  CLIENT_TIME_ZONE,
  cutoffReminderDue,
  cutoffReminderText,
  parseWorkHours,
} from '@detaly/domain';
import { enqueueOutbox, loadRosskoSettings } from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import type { NotifyAlertJobData } from '../notify';
import { nudge } from './common';

export interface RosskoCutoffResult {
  /** The cutoff key due now, or null (no cutoff times, a day off, outside every window). */
  due: string | null;
  /** Orders not ordered yet (counted only when a cutoff is due). */
  notOrdered: number;
  /** The outbox key queued by this run; null when nothing was queued. */
  alerted: string | null;
}

/** Orders the supplier has not got yet (see the header). */
export async function countNotOrdered(deps: Pick<WorkerDeps, 'db'>): Promise<number> {
  const [row] = await deps.db
    .select({ count: sql<number>`count(distinct ${orders.id})::int` })
    .from(orders)
    .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(
      and(
        inArray(orders.status, ['confirmed', 'needs_attention']),
        eq(orderItems.state, 'pending'),
      ),
    );
  return Number(row?.count ?? 0);
}

export async function runRosskoCutoff(deps: WorkerDeps): Promise<RosskoCutoffResult> {
  const now = deps.now();
  const { cutoffTimes } = await loadRosskoSettings(deps.db);
  if (cutoffTimes.length === 0) return { due: null, notOrdered: 0, alerted: null };
  const due = cutoffReminderDue({
    now,
    cutoffTimes,
    schedule: parseWorkHours(deps.env.PICKUP_HOURS ?? null),
    timeZone: CLIENT_TIME_ZONE,
  });
  if (due === null) return { due: null, notOrdered: 0, alerted: null };
  const notOrdered = await countNotOrdered(deps);
  if (notOrdered === 0) return { due: due.key, notOrdered, alerted: null };
  const data: NotifyAlertJobData = {
    audience: 'sellers',
    text: cutoffReminderText({ minutesLeft: due.minutesLeft, cutoff: due.cutoff, notOrdered }),
    dedupeKey: due.key,
  };
  const key = `alert:${due.key}`;
  const queued = await enqueueOutbox(deps.db, {
    queue: 'notify',
    name: NOTIFY_JOBS.alert,
    key,
    data: { ...data },
  });
  if (!queued) return { due: due.key, notOrdered, alerted: null };
  nudge(deps);
  deps.logger.info({ cutoff: due.cutoff, notOrdered }, 'rossko cutoff reminder queued');
  return { due: due.key, notOrdered, alerted: key };
}
