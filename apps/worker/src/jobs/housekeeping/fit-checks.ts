// housekeeping/fit-checks, every 5 minutes (step 4, docs/fit-check.md):
//
// 1. expiry: fit checks nobody answered for 24 hours (fit_checks.expires_at) become `expired`;
//    the open card of each request is redrawn (outbox notify/fit refresh, key
//    `fit:<request>:refresh:expired`). The client's cart shows «Мастер не успел ответить» from
//    expires_at on anyway, before this run marks the rows;
// 2. the SLA reminder: a request still waiting longer than `fit_check.sla_minutes` (60) of the
//    pickup point's working hours (PICKUP_HOURS; night and days off do not count) gets its card
//    posted again with «Без ответа …», once: the outbox key `fit:<request>:sla` is unique, so
//    later runs (and a restarted worker) never queue it again.
//
// The retention of fit_checks.vin and comment (90 days) runs with the daily retention job.
// Logs: counters only.
import { and, asc, eq, fitChecks, gt, sql } from '@detaly/db';
import { fitCheckOverdue, parseWorkHours } from '@detaly/domain';
import {
  enqueueFitNotify,
  expireFitChecks,
  fitRefreshKey,
  fitReminderKey,
  loadFitSlaMinutes,
} from '@detaly/vin';
import type { WorkerDeps } from '../../deps';
import { BATCH, MINUTE_MS, notAfter, nudge } from './common';

export interface FitChecksResult {
  /** Requests whose waiting lines expired in this run. */
  expired: number;
  /** SLA reminders queued by this run. */
  reminders: number;
}

/** The extra line of the reminder card (no PD). */
export function fitReminderNote(slaMinutes: number): string {
  return slaMinutes === 60
    ? 'Без ответа больше часа — клиент ждёт'
    : `Без ответа больше ${slaMinutes} мин — клиент ждёт`;
}

export async function runFitChecks(deps: WorkerDeps): Promise<FitChecksResult> {
  const now = deps.now();
  const result: FitChecksResult = { expired: 0, reminders: 0 };

  // 1. expiry
  const expired = await expireFitChecks(deps.db, now);
  for (const requestId of expired) {
    await enqueueFitNotify(deps.db, {
      requestId,
      kind: 'refresh',
      key: fitRefreshKey(requestId, 'expired'),
    });
  }
  result.expired = expired.length;

  // 2. the SLA reminder, once per request. Working minutes never exceed the wall-clock ones, so
  // only requests at least `sla` wall-clock minutes old can be overdue. Requests reminded
  // already are left out, so a full batch of them never hides a newer one.
  const sla = await loadFitSlaMinutes(deps.db);
  const schedule = parseWorkHours(deps.env.PICKUP_HOURS ?? null);
  const waiting = await deps.db
    .selectDistinct({ requestId: fitChecks.requestId, createdAt: fitChecks.createdAt })
    .from(fitChecks)
    .where(
      and(
        eq(fitChecks.status, 'pending'),
        notAfter(fitChecks.createdAt, new Date(now.getTime() - sla * MINUTE_MS)),
        gt(fitChecks.expiresAt, now),
        // The key of fitReminderKey; qualified, as drizzle leaves the columns of a single-table
        // select unqualified.
        sql`not exists (select 1 from outbox o where o.job_id = 'fit:' || "fit_checks"."request_id"::text || ':sla')`,
      ),
    )
    .orderBy(asc(fitChecks.createdAt), asc(fitChecks.requestId))
    .limit(BATCH);
  const note = fitReminderNote(sla);
  for (const request of waiting) {
    if (!fitCheckOverdue(request.createdAt, now, sla, schedule)) continue;
    const queued = await enqueueFitNotify(deps.db, {
      requestId: request.requestId,
      kind: 'reminder',
      key: fitReminderKey(request.requestId),
      note,
    });
    if (queued) result.reminders += 1;
  }

  if (result.expired > 0 || result.reminders > 0) {
    nudge(deps);
    deps.logger.info({ ...result }, 'fit checks: expiry and SLA reminders');
  }
  return result;
}
