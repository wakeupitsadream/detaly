// housekeeping/reviews-check, Mondays at 10:05 Asia/Yekaterinburg (step 3, docs/reviews.md): a
// reminder to the sellers chat to update the rating snapshot on /admin/reviews and to answer the
// new reviews in the map services' business accounts — five minutes after the price check of
// step 2, in the same style. Skipped when no review link is set (REVIEW_URL_*) or when the
// snapshot (settings `reviews.snapshot`) was saved in the last 7 days. The alert is a notify/alert
// outbox row keyed by the local date, so a repeated run sends it once; no personal data.
import { NOTIFY_JOBS, reviewPlatforms } from '@detaly/config';
import { eq, settings } from '@detaly/db';
import { localDate, REVIEW_SNAPSHOT_KEY, type ReviewPlatform } from '@detaly/domain';
import { enqueueOutbox } from '@detaly/orders';
import type { WorkerDeps } from '../../deps';
import type { NotifyAlertJobData } from '../notify';
import { DAY_MS, nudge } from './common';

/** A snapshot saved this recently makes the reminder unnecessary. */
export const REVIEWS_CHECK_FRESH_DAYS = 7;

export interface ReviewsCheckResult {
  /** Why nothing was queued: no review link, or a fresh snapshot; null when queued (or a dupe). */
  skipped: 'no_links' | 'fresh' | null;
  /** Outbox key of the reminder queued by this run, null when none was queued. */
  alerted: string | null;
}

/** Where the reviews are answered: the business accounts of the configured platforms. */
const ANSWER_PLACES: Record<ReviewPlatform, string> = {
  yandex: 'Яндекс Бизнесе',
  '2gis': '2ГИС',
};

export function reviewsCheckText(baseUrl: string, platforms: readonly ReviewPlatform[]): string {
  const link = new URL('/admin/reviews', baseUrl).toString();
  const places = platforms.map((platform) => ANSWER_PLACES[platform]).join(' и ');
  return `Отзывы: обновите рейтинг в /admin/reviews и ответьте на новые отзывы в ${places} — ${link}`;
}

export async function runReviewsCheck(deps: WorkerDeps): Promise<ReviewsCheckResult> {
  const platforms = reviewPlatforms(deps.env);
  if (platforms.length === 0) return { skipped: 'no_links', alerted: null };
  const now = deps.now();
  const [row] = await deps.db
    .select({ updatedAt: settings.updatedAt })
    .from(settings)
    .where(eq(settings.key, REVIEW_SNAPSHOT_KEY));
  if (row && now.getTime() - row.updatedAt.getTime() < REVIEWS_CHECK_FRESH_DAYS * DAY_MS) {
    return { skipped: 'fresh', alerted: null };
  }

  const dedupeKey = `reviews-check:${localDate(now)}`;
  const data: NotifyAlertJobData = {
    audience: 'sellers',
    text: reviewsCheckText(deps.env.APP_BASE_URL, platforms),
    dedupeKey,
  };
  const queued = await enqueueOutbox(deps.db, {
    queue: 'notify',
    name: NOTIFY_JOBS.alert,
    key: `alert:${dedupeKey}`,
    data: { ...data },
  });
  if (queued) nudge(deps);
  return { skipped: null, alerted: queued ? `alert:${dedupeKey}` : null };
}
