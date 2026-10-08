// housekeeping/price-check, Mondays at 10:00 Asia/Yekaterinburg (step 2, docs/pricing.md): a
// reminder to the sellers chat to compare 20–30 popular parts with competitors on /admin/prices,
// unless the last 7 days already have PRICE_CHECK_TARGET records. The alert is a notify/alert
// outbox row keyed by the local date, so a repeated run sends it once; no personal data.
import { NOTIFY_JOBS } from '@detaly/config';
import { gt, priceBenchmarks, sql } from '@detaly/db';
import { localDate } from '@detaly/domain';
import { enqueueOutbox } from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import type { NotifyAlertJobData } from '../notify';
import { DAY_MS, nudge } from './common';

/** Records of the last week that make the reminder unnecessary. */
export const PRICE_CHECK_TARGET = 20;

export interface PriceCheckResult {
  /** Records captured in the last 7 days. */
  lastWeek: number;
  /** Outbox key of the reminder queued by this run, null when none was queued. */
  alerted: string | null;
}

export function priceCheckText(baseUrl: string, lastWeek: number): string {
  const link = new URL('/admin/prices', baseUrl).toString();
  return (
    `Пора сверить цены: внесите 20–30 позиций — ${link}` +
    (lastWeek > 0 ? `\nЗа последние 7 дней внесено: ${lastWeek}.` : '')
  );
}

export async function runPriceCheck(deps: WorkerDeps): Promise<PriceCheckResult> {
  const now = deps.now();
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const [row] = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(priceBenchmarks)
    .where(gt(priceBenchmarks.capturedAt, since));
  const lastWeek = Number(row?.count ?? 0);
  if (lastWeek >= PRICE_CHECK_TARGET) return { lastWeek, alerted: null };

  const dedupeKey = `price-check:${localDate(now)}`;
  const data: NotifyAlertJobData = {
    audience: 'sellers',
    text: priceCheckText(deps.env.APP_BASE_URL, lastWeek),
    dedupeKey,
  };
  const queued = await enqueueOutbox(deps.db, {
    queue: 'notify',
    name: NOTIFY_JOBS.alert,
    key: `alert:${dedupeKey}`,
    data: { ...data },
  });
  if (queued) nudge(deps);
  return { lastWeek, alerted: queued ? `alert:${dedupeKey}` : null };
}
