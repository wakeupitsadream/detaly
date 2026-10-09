/**
 * Read model of /admin/fit-checks (step 4, docs/fit-check.md): the latest fit check requests
 * (time, lines, the status of every line, who answered and when) and the statistics of the last
 * 7 and 30 days (fitCheckStats: requests, lines, the share of every answer and of the expired,
 * the median answer time and the share within the SLA in working minutes of the point, the share
 * of checked lines that ended up in a paid order), plus the SLA setting with its version.
 *
 * The VIN and the comment are never read here: the master sees them in the bot card only.
 */
import {
  desc,
  eq,
  fitChecks,
  gt,
  inArray,
  settings,
  sql,
  staff,
  asc,
  type Executor,
} from '@detaly/db';
import {
  DEFAULT_FIT_CHECK_SLA_MINUTES,
  FIT_CHECK_SLA_KEY,
  fitCheckStats,
  fitRequestNumber,
  type FitCheckStats,
  type FitCheckStatus,
  type WeekSchedule,
} from '@detaly/domain';
import { isFitSlaMinutes } from '@detaly/vin';
import { settingsVersion } from './settings-writer';

/** Requests listed on the page (the newest first). */
export const ADMIN_FIT_REQUESTS = 50;
/** Periods of the statistics, days. */
export const FIT_STATS_DAYS = [7, 30] as const;
/** Who answered a line from the admin (Basic auth has no staff member). */
export const FIT_ADMIN_ANSWERER = 'админка';

const DAY_MS = 86_400_000;

export interface AdminFitLine {
  id: string;
  /** Position in the request (1-based), as the bot card numbers it. */
  n: number;
  brand: string;
  article: string;
  name: string;
  status: FitCheckStatus;
  analog: { brand: string; article: string; name: string | null } | null;
  answeredAt: Date | null;
  /** The staff member's name, «админка», or null while nobody answered. */
  answeredBy: string | null;
}

export interface AdminFitRequest {
  requestId: string;
  /** Short number shared with the bot card. */
  number: string;
  createdAt: Date;
  expiresAt: Date;
  lines: AdminFitLine[];
  /** Some line still waits for the master. */
  waiting: boolean;
}

export interface AdminFitStats {
  days: number;
  stats: FitCheckStats;
}

export interface AdminFitChecksData {
  requests: AdminFitRequest[];
  stats: AdminFitStats[];
  sla: {
    minutes: number;
    /** settingsVersion of the stored row ('none' without one): the form's optimistic version. */
    version: string;
    updatedAt: Date | null;
    updatedBy: string | null;
  };
  /** PICKUP_HOURS is understood: the SLA counts working minutes (otherwise every minute). */
  scheduleKnown: boolean;
}

async function loadRequests(db: Executor): Promise<AdminFitRequest[]> {
  const firstAt = sql<Date>`min(${fitChecks.createdAt})`;
  const recent = await db
    .select({ requestId: fitChecks.requestId })
    .from(fitChecks)
    .groupBy(fitChecks.requestId)
    .orderBy(desc(firstAt))
    .limit(ADMIN_FIT_REQUESTS);
  if (recent.length === 0) return [];
  const rows = await db
    .select({
      id: fitChecks.id,
      requestId: fitChecks.requestId,
      brand: fitChecks.brand,
      article: fitChecks.article,
      name: fitChecks.name,
      status: fitChecks.status,
      analogBrand: fitChecks.analogBrand,
      analogArticle: fitChecks.analogArticle,
      analogName: fitChecks.analogName,
      answeredAt: fitChecks.answeredAt,
      answeredBy: fitChecks.answeredBy,
      staffName: staff.name,
      createdAt: fitChecks.createdAt,
      expiresAt: fitChecks.expiresAt,
    })
    .from(fitChecks)
    .leftJoin(staff, eq(staff.id, fitChecks.answeredBy))
    .where(
      inArray(
        fitChecks.requestId,
        recent.map((row) => row.requestId),
      ),
    )
    .orderBy(asc(fitChecks.createdAt), asc(fitChecks.id));

  const byRequest = new Map<string, AdminFitRequest>();
  for (const { requestId } of recent) {
    const first = rows.find((row) => row.requestId === requestId);
    if (!first) continue;
    byRequest.set(requestId, {
      requestId,
      number: fitRequestNumber(requestId),
      createdAt: first.createdAt,
      expiresAt: first.expiresAt,
      lines: [],
      waiting: false,
    });
  }
  for (const row of rows) {
    const request = byRequest.get(row.requestId);
    if (!request) continue;
    const status = row.status as FitCheckStatus;
    request.lines.push({
      id: row.id,
      n: request.lines.length + 1,
      brand: row.brand,
      article: row.article,
      name: row.name,
      status,
      analog:
        row.analogBrand !== null && row.analogArticle !== null
          ? { brand: row.analogBrand, article: row.analogArticle, name: row.analogName }
          : null,
      answeredAt: row.answeredAt,
      answeredBy:
        row.answeredAt === null
          ? null
          : (row.staffName ?? (row.answeredBy === null ? FIT_ADMIN_ANSWERER : null)),
    });
    if (status === 'pending') request.waiting = true;
  }
  return [...byRequest.values()];
}

async function loadStats(
  db: Executor,
  now: Date,
  slaMinutes: number,
  schedule: WeekSchedule | null,
): Promise<AdminFitStats[]> {
  const longest = Math.max(...FIT_STATS_DAYS);
  const since = new Date(now.getTime() - longest * DAY_MS);
  const rows = await db
    .select({
      requestId: fitChecks.requestId,
      status: fitChecks.status,
      createdAt: fitChecks.createdAt,
      answeredAt: fitChecks.answeredAt,
      // The line went into an order that is paid (the check is copied at checkout).
      // (Qualified names: drizzle leaves the columns of a single-table select unqualified.)
      paid: sql<boolean>`exists (select 1 from order_items oi inner join orders o on o.id = oi.order_id where oi.fit_check_id = "fit_checks"."id" and o.paid_at is not null)`,
    })
    .from(fitChecks)
    .where(gt(fitChecks.createdAt, since));
  return FIT_STATS_DAYS.map((days) => {
    const from = now.getTime() - days * DAY_MS;
    const inPeriod = rows
      .filter((row) => row.createdAt.getTime() > from)
      .map((row) => ({
        requestId: row.requestId,
        status: row.status as FitCheckStatus,
        createdAt: row.createdAt,
        answeredAt: row.answeredAt,
        paid: row.paid === true,
      }));
    return { days, stats: fitCheckStats(inPeriod, { slaMinutes, schedule }) };
  });
}

export async function loadAdminFitChecks(
  db: Executor,
  input: { now: Date; schedule: WeekSchedule | null | undefined },
): Promise<AdminFitChecksData> {
  const [slaRow] = await db
    .select({ value: settings.value, updatedAt: settings.updatedAt, updatedBy: settings.updatedBy })
    .from(settings)
    .where(eq(settings.key, FIT_CHECK_SLA_KEY));
  const value = slaRow?.value as unknown;
  const minutes = isFitSlaMinutes(value) ? value : DEFAULT_FIT_CHECK_SLA_MINUTES;
  const schedule = input.schedule ?? null;
  const [requests, stats] = await Promise.all([
    loadRequests(db),
    loadStats(db, input.now, minutes, schedule),
  ]);
  return {
    requests,
    stats,
    sla: {
      minutes,
      version: settingsVersion(slaRow),
      updatedAt: slaRow?.updatedAt ?? null,
      updatedBy: slaRow?.updatedBy ?? null,
    },
    scheduleKnown: schedule !== null && schedule.length === 7,
  };
}
