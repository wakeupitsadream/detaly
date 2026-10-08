/**
 * Read model of /admin/reviews (step 3, docs/reviews.md): whether the review links are set (env
 * REVIEW_URL_*), the rating snapshot the owner reads off the cards and saves here (settings
 * `reviews.snapshot`, through the audited settings writer of step 2), the history of its changes,
 * what the storefront shows now and the funnel of the last 30 and 90 days.
 */
import { reviewUrls, settingsDefaultsFromEnv, type Env } from '@detaly/config';
import {
  and,
  claims,
  desc,
  eq,
  gt,
  inArray,
  notifications,
  orderEvents,
  orders,
  settings,
  settingsAudit,
  sql,
  type Executor,
} from '@detaly/db';
import {
  diffDays,
  isIsoDate,
  localDate,
  normalizeReviewSnapshot,
  parseRatingX10,
  parseReviewCount,
  parseReviewSnapshot,
  ratingBlock,
  REVIEW_PLATFORM_LABELS,
  REVIEW_PLATFORMS,
  REVIEW_SNAPSHOT_KEY,
  type IsoDate,
  type JournalEvent,
  type OrderNotifyTemplate,
  type RatingBlock,
  type ReviewPlatform,
  type ReviewRating,
  type ReviewSnapshot,
} from '@detaly/domain';
import { resolveRatingSettings } from '../reviews/rating';
import { settingsVersion } from './settings-writer';

/** History rows shown under the form. */
export const SNAPSHOT_AUDIT_ROWS = 10;
/** Periods of the funnel, days. */
export const FUNNEL_DAYS = [30, 90] as const;

const DAY_MS = 86_400_000;
const LINK_OPENED: JournalEvent = 'review_link_opened';
const FUNNEL_TEMPLATES: readonly OrderNotifyTemplate[] = ['how_is_it', 'review_reminder'];

/** Field names of the snapshot form. */
export const SNAPSHOT_FIELDS = {
  asOf: 'as_of',
  rating: (platform: ReviewPlatform) => `rating_${platform}`,
  count: (platform: ReviewPlatform) => `count_${platform}`,
} as const;

export interface ReviewLinkStatus {
  platform: ReviewPlatform;
  label: string;
  /** REVIEW_URL_<platform>; null: not set, the platform is not offered anywhere. */
  url: string | null;
}

export interface ReviewFunnel {
  days: number;
  /** «Как деталь?» delivered. */
  howIsItSent: number;
  /** The review reminder delivered. */
  reminderSent: number;
  /** First opens of a review link per platform (one per order and platform). */
  opened: Record<ReviewPlatform, number>;
  /** Orders with any review link opened. */
  openedOrders: number;
  /** Claims opened after the handover. */
  claimsAfterHandover: number;
}

export interface SnapshotAuditRow {
  id: string;
  changedAt: Date;
  changedBy: string;
  oldValue: ReviewSnapshot | null;
  newValue: ReviewSnapshot | null;
}

/** Why the storefront shows no rating line (null when it shows one). */
export type RatingHiddenReason = 'no_links' | 'no_snapshot' | 'too_old' | 'too_few' | null;

export interface AdminReviewsData {
  links: ReviewLinkStatus[];
  /** At least one link is set: the buttons, /review and the reminder exist. */
  enabled: boolean;
  snapshot: ReviewSnapshot | null;
  /** The optimistic version of the form (settings.updated_at of the snapshot row). */
  version: string;
  updatedAt: Date | null;
  updatedBy: string | null;
  /** Today in Asia/Yekaterinburg: the default «на дату» and the latest date allowed. */
  today: IsoDate;
  minCount: number;
  maxAgeDays: number;
  reminderDays: number;
  /** What the storefront shows now (home, /search). */
  storefront: RatingBlock | null;
  hiddenReason: RatingHiddenReason;
  audit: SnapshotAuditRow[];
  funnel: ReviewFunnel[];
  /** What the QR of the counter sign encodes: APP_BASE_URL + /review. */
  reviewPageUrl: string;
}

export function reviewPageUrl(env: Pick<Env, 'APP_BASE_URL'>): string {
  return new URL('/review', env.APP_BASE_URL).toString();
}

function hiddenReason(
  data: Pick<AdminReviewsData, 'enabled' | 'snapshot' | 'maxAgeDays' | 'today' | 'storefront'>,
): RatingHiddenReason {
  if (data.storefront !== null) return null;
  if (!data.enabled) return 'no_links';
  if (data.snapshot === null || Object.keys(data.snapshot.ratings).length === 0) {
    return 'no_snapshot';
  }
  const age = diffDays(data.snapshot.asOf, data.today);
  if (age < 0 || age > data.maxAgeDays) return 'too_old';
  return 'too_few';
}

export async function loadReviewFunnel(
  db: Executor,
  now: Date,
  days: number,
): Promise<ReviewFunnel> {
  const since = new Date(now.getTime() - days * DAY_MS);
  const [sent] = await db
    .select({
      howIsIt: sql<number>`count(*) filter (where ${notifications.template} = ${'how_is_it'})::int`,
      reminder: sql<number>`count(*) filter (where ${notifications.template} = ${'review_reminder'})::int`,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.status, 'sent'),
        inArray(notifications.template, [...FUNNEL_TEMPLATES]),
        gt(notifications.sentAt, since),
      ),
    );
  const platform = sql<string>`${orderEvents.payload}->>'platform'`;
  const openedRows = await db
    .select({
      platform,
      count: sql<number>`count(*)::int`,
      orders: sql<number>`count(distinct ${orderEvents.orderId})::int`,
    })
    .from(orderEvents)
    .where(and(eq(orderEvents.type, LINK_OPENED), gt(orderEvents.createdAt, since)))
    .groupBy(platform);
  const [openedOrders] = await db
    .select({ count: sql<number>`count(distinct ${orderEvents.orderId})::int` })
    .from(orderEvents)
    .where(and(eq(orderEvents.type, LINK_OPENED), gt(orderEvents.createdAt, since)));
  const [claimRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(claims)
    .innerJoin(orders, eq(orders.id, claims.orderId))
    .where(and(gt(claims.openedAt, since), sql`${claims.openedAt} >= ${orders.handedAt}`));
  const opened = Object.fromEntries(REVIEW_PLATFORMS.map((p) => [p, 0])) as Record<
    ReviewPlatform,
    number
  >;
  for (const row of openedRows) {
    if ((REVIEW_PLATFORMS as readonly string[]).includes(row.platform)) {
      opened[row.platform as ReviewPlatform] = Number(row.count);
    }
  }
  return {
    days,
    howIsItSent: Number(sent?.howIsIt ?? 0),
    reminderSent: Number(sent?.reminder ?? 0),
    opened,
    openedOrders: Number(openedOrders?.count ?? 0),
    claimsAfterHandover: Number(claimRow?.count ?? 0),
  };
}

export async function loadAdminReviews(
  db: Executor,
  env: Env,
  now: Date,
): Promise<AdminReviewsData> {
  const urls = reviewUrls(env);
  const links = REVIEW_PLATFORMS.map((platform) => ({
    platform,
    label: REVIEW_PLATFORM_LABELS[platform],
    url: urls[platform],
  }));
  const rows = await db
    .select({
      key: settings.key,
      value: settings.value,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy,
    })
    .from(settings)
    .where(
      inArray(settings.key, [
        REVIEW_SNAPSHOT_KEY,
        'reviews.min_count',
        'reviews.max_age_days',
        'reviews.reminder_days',
      ]),
    );
  const values = new Map(rows.map((row) => [row.key, row.value as unknown]));
  const rating = resolveRatingSettings(values, env);
  const reminderRaw = values.get('reviews.reminder_days');
  const snapshotRow = rows.find((row) => row.key === REVIEW_SNAPSHOT_KEY) ?? null;
  const today = localDate(now);
  const enabled = links.some((link) => link.url !== null);
  const storefront = enabled
    ? ratingBlock(rating.snapshot, {
        urls,
        minCount: rating.minCount,
        maxAgeDays: rating.maxAgeDays,
        today,
      })
    : null;

  const auditRows = await db
    .select()
    .from(settingsAudit)
    .where(eq(settingsAudit.key, REVIEW_SNAPSHOT_KEY))
    .orderBy(desc(settingsAudit.changedAt), desc(settingsAudit.id))
    .limit(SNAPSHOT_AUDIT_ROWS);
  const funnel: ReviewFunnel[] = [];
  for (const days of FUNNEL_DAYS) funnel.push(await loadReviewFunnel(db, now, days));

  const data = {
    links,
    enabled,
    snapshot: rating.snapshot,
    version: settingsVersion(snapshotRow),
    updatedAt: snapshotRow?.updatedAt ?? null,
    updatedBy: snapshotRow?.updatedBy ?? null,
    today,
    minCount: rating.minCount,
    maxAgeDays: rating.maxAgeDays,
    reminderDays:
      typeof reminderRaw === 'number' && Number.isSafeInteger(reminderRaw) && reminderRaw >= 0
        ? reminderRaw
        : settingsDefaultsFromEnv(env)['reviews.reminder_days'],
    storefront,
    audit: auditRows.map((row) => ({
      id: row.id,
      changedAt: row.changedAt,
      changedBy: row.changedBy,
      oldValue: parseReviewSnapshot(row.oldValue),
      newValue: parseReviewSnapshot(row.newValue),
    })),
    funnel,
    reviewPageUrl: reviewPageUrl(env),
  };
  return { ...data, hiddenReason: hiddenReason(data) };
}

// ---------------------------------------------------------------------------------------------
// The snapshot form (POST /api/admin/reviews)
// ---------------------------------------------------------------------------------------------

export type SnapshotFormResult =
  { ok: true; snapshot: ReviewSnapshot } | { ok: false; errors: string[] };

/** 'YYYY-MM-DD' of <input type=date>, or «20.10.2026» typed by hand. */
function parseDay(text: string): IsoDate | null {
  const trimmed = text.trim();
  if (isIsoDate(trimmed)) return trimmed;
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (!match) return null;
  const iso = `${match[3]}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * The fields of the form -> a snapshot in normal form, or the errors in the owner's words. Per
 * platform: the rating (1,0–5,0, one decimal, a comma or a dot) and the number of reviews (a whole
 * number ≥ 0) together, or both empty (no numbers for that platform). «На дату»: a real day, not
 * after today.
 */
export function parseSnapshotForm(form: URLSearchParams, today: IsoDate): SnapshotFormResult {
  const errors: string[] = [];
  const asOf = parseDay((form.get(SNAPSHOT_FIELDS.asOf) ?? '').slice(0, 16));
  if (asOf === null) errors.push('«На дату» — дата в виде ДД.ММ.ГГГГ');
  else if (asOf > today) errors.push('«На дату» не может быть позже сегодняшнего дня');
  const ratings: Partial<Record<ReviewPlatform, ReviewRating>> = {};
  for (const platform of REVIEW_PLATFORMS) {
    const label = REVIEW_PLATFORM_LABELS[platform];
    const ratingText = (form.get(SNAPSHOT_FIELDS.rating(platform)) ?? '').trim().slice(0, 16);
    const countText = (form.get(SNAPSHOT_FIELDS.count(platform)) ?? '').trim().slice(0, 16);
    if (ratingText === '' && countText === '') continue;
    if (ratingText === '' || countText === '') {
      errors.push(`${label}: укажите и оценку, и число отзывов — или оставьте оба поля пустыми`);
      continue;
    }
    const ratingX10 = parseRatingX10(ratingText);
    const count = parseReviewCount(countText);
    if (ratingX10 === null) {
      errors.push(`${label}: оценка — от 1,0 до 5,0, один знак после запятой (например 4,9)`);
    }
    if (count === null) errors.push(`${label}: число отзывов — целое число от 0`);
    if (ratingX10 !== null && count !== null) ratings[platform] = { ratingX10, count };
  }
  if (errors.length > 0 || asOf === null) return { ok: false, errors };
  return { ok: true, snapshot: normalizeReviewSnapshot({ asOf, ratings }) };
}
