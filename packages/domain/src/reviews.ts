/**
 * Step 3 (docs/reviews.md): reviews after the handover on the shop's own cards in Яндекс Карты
 * and 2ГИС. Pure functions: the rating snapshot the owner types on /admin/reviews (the services
 * have no public API for ratings), the conditions of the storefront rating line and of the one
 * review reminder after `completed`.
 *
 * Founder decisions (fixed): no rewards for a review and no review gating — every client gets
 * both review buttons and an equal «Есть проблема»; nothing here looks at how the client feels
 * about the order. The platform names are plain text, never logos.
 */
import { diffDays, isIsoDate } from './dates';
import { isOneOf, REVIEW_PLATFORMS, type OrderStatus, type ReviewPlatform } from './statuses';
import type { IsoDate } from './types';

/** settings key of the rating snapshot: no seeded default, absent until the admin saves one. */
export const REVIEW_SNAPSHOT_KEY = 'reviews.snapshot';

/** Defaults of the settings (settingsDefaultsFromEnv): the reminder 3 days after `completed`. */
export const DEFAULT_REVIEW_REMINDER_DAYS = 3;
/** The storefront line needs at least 5 reviews on a platform. */
export const DEFAULT_REVIEW_MIN_COUNT = 5;
/** …and a snapshot at most 45 days old. */
export const DEFAULT_REVIEW_MAX_AGE_DAYS = 45;

/** The names of the services: «Яндекс Карты», «2ГИС». */
export const REVIEW_PLATFORM_LABELS: Readonly<Record<ReviewPlatform, string>> = {
  yandex: 'Яндекс Карты',
  '2gis': '2ГИС',
};

/** Where a rating is, in parts (the place links to the card): «на» + «Яндекс Картах». */
export const REVIEW_PLATFORM_PLACE: Readonly<
  Record<ReviewPlatform, { preposition: string; place: string }>
> = {
  yandex: { preposition: 'на', place: 'Яндекс Картах' },
  '2gis': { preposition: 'в', place: '2ГИС' },
};

/** Where a rating is: «4,9 на Яндекс Картах», «4,8 в 2ГИС». */
export const REVIEW_PLATFORM_WHERE: Readonly<Record<ReviewPlatform, string>> = {
  yandex: `${REVIEW_PLATFORM_PLACE.yandex.preposition} ${REVIEW_PLATFORM_PLACE.yandex.place}`,
  '2gis': `${REVIEW_PLATFORM_PLACE['2gis'].preposition} ${REVIEW_PLATFORM_PLACE['2gis'].place}`,
};

/** The review buttons of the messages and the order page. */
export const REVIEW_BUTTON_TEXTS: Readonly<Record<ReviewPlatform, string>> = {
  yandex: 'Отзыв в Яндекс Картах',
  '2gis': 'Отзыв в 2ГИС',
};

/**
 * Our redirect under an order page (`/o/<token>` or its absolute URL): the review buttons never
 * point to the map services directly, so the shop knows a link was opened (docs/reviews.md).
 */
export function reviewRedirectPath(orderPath: string, platform: ReviewPlatform): string {
  return `${orderPath.replace(/\/+$/, '')}/review/${platform}`;
}

export interface ReviewRating {
  /** The rating × 10, an integer 10..50: 49 is «4,9» (no floats are stored). */
  ratingX10: number;
  /** Reviews on the card, an integer ≥ 0. */
  count: number;
}

/** settings `reviews.snapshot`: what the owner read off the cards on `asOf`. */
export interface ReviewSnapshot {
  /** The day the numbers were read (Asia/Yekaterinburg). */
  asOf: IsoDate;
  /** A platform without numbers is absent. */
  ratings: Partial<Record<ReviewPlatform, ReviewRating>>;
}

export const MIN_RATING_X10 = 10;
export const MAX_RATING_X10 = 50;
export const MAX_REVIEW_COUNT = 1_000_000;

/** '4,9', '4.9', '5' -> 49, 49, 50: one decimal at most, from 1,0 to 5,0; null otherwise. */
export function parseRatingX10(text: string): number | null {
  const match = /^(\d)(?:[.,](\d))?$/.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]) * 10 + Number(match[2] ?? '0');
  return value >= MIN_RATING_X10 && value <= MAX_RATING_X10 ? value : null;
}

/** 49 -> '4,9', 50 -> '5,0' (the Russian decimal comma). */
export function formatRatingX10(ratingX10: number): string {
  return `${Math.floor(ratingX10 / 10)},${ratingX10 % 10}`;
}

/** '37', '1 200' -> 37, 1200: a whole number from 0 to MAX_REVIEW_COUNT; null otherwise. */
export function parseReviewCount(text: string): number | null {
  const digits = text.replace(/[\s\u00a0]/g, '');
  if (!/^\d{1,7}$/.test(digits)) return null;
  const value = Number(digits);
  return value <= MAX_REVIEW_COUNT ? value : null;
}

function isRating(value: unknown): value is ReviewRating {
  if (typeof value !== 'object' || value === null) return false;
  const { ratingX10, count } = value as Record<string, unknown>;
  return (
    typeof ratingX10 === 'number' &&
    Number.isInteger(ratingX10) &&
    ratingX10 >= MIN_RATING_X10 &&
    ratingX10 <= MAX_RATING_X10 &&
    typeof count === 'number' &&
    Number.isInteger(count) &&
    count >= 0 &&
    count <= MAX_REVIEW_COUNT
  );
}

/** The snapshot in normal form: platforms in REVIEW_PLATFORMS order, only the two fields. */
export function normalizeReviewSnapshot(snapshot: ReviewSnapshot): ReviewSnapshot {
  const ratings: Partial<Record<ReviewPlatform, ReviewRating>> = {};
  for (const platform of REVIEW_PLATFORMS) {
    const rating = snapshot.ratings[platform];
    if (rating) ratings[platform] = { ratingX10: rating.ratingX10, count: rating.count };
  }
  return { asOf: snapshot.asOf, ratings };
}

/**
 * The stored value -> a snapshot in normal form; null when it is malformed (a hand edit in the
 * database): readers then ignore it, as any broken setting.
 */
export function parseReviewSnapshot(value: unknown): ReviewSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isIsoDate(raw.asOf)) return null;
  const list = raw.ratings;
  if (typeof list !== 'object' || list === null || Array.isArray(list)) return null;
  const ratings: Partial<Record<ReviewPlatform, ReviewRating>> = {};
  for (const [platform, rating] of Object.entries(list)) {
    if (!isOneOf(REVIEW_PLATFORMS, platform) || !isRating(rating)) return null;
    ratings[platform] = rating;
  }
  return normalizeReviewSnapshot({ asOf: raw.asOf, ratings });
}

/** Same numbers and date (both in normal form). */
export function sameReviewSnapshot(a: ReviewSnapshot | null, b: ReviewSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(normalizeReviewSnapshot(a)) === JSON.stringify(normalizeReviewSnapshot(b));
}

export interface RatingLine {
  platform: ReviewPlatform;
  ratingX10: number;
  count: number;
  /** The platform's review link (REVIEW_URL_*): the name of the service links to it. */
  url: string;
}

export interface RatingBlock {
  asOf: IsoDate;
  lines: RatingLine[];
}

export interface RatingBlockInput {
  /** REVIEW_URL_* by platform; a platform without a link is never shown. */
  urls: Partial<Record<ReviewPlatform, string | null | undefined>>;
  /** reviews.min_count */
  minCount: number;
  /** reviews.max_age_days */
  maxAgeDays: number;
  /** Today in Asia/Yekaterinburg. */
  today: IsoDate;
}

/**
 * The storefront rating line (home, /search). A platform is shown only when its review link is
 * set, it has at least `minCount` reviews (and at least one) and the snapshot is at most
 * `maxAgeDays` old; a snapshot dated after today (a typo) is not shown either. null: nothing to
 * show — the block is left out, never replaced by a made-up rating.
 */
export function ratingBlock(
  snapshot: ReviewSnapshot | null,
  input: RatingBlockInput,
): RatingBlock | null {
  if (snapshot === null) return null;
  const age = diffDays(snapshot.asOf, input.today);
  if (age < 0 || age > input.maxAgeDays) return null;
  const lines = REVIEW_PLATFORMS.flatMap((platform): RatingLine[] => {
    const rating = snapshot.ratings[platform];
    const url = input.urls[platform];
    if (!rating || !url || rating.count < Math.max(input.minCount, 1)) return [];
    return [{ platform, ratingX10: rating.ratingX10, count: rating.count, url }];
  });
  return lines.length > 0 ? { asOf: snapshot.asOf, lines } : null;
}

/** A reminder this much later than due (the worker was down) is no longer sent. */
export const REVIEW_REMINDER_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

/** Facts of one order for the review reminder (housekeeping and the send check of notify). */
export interface ReviewReminderFacts {
  status: OrderStatus;
  completedAt: Date | null;
  now: Date;
  /** reviews.reminder_days; 0 switches the reminder off. */
  reminderDays: number;
  /** A review link of the order was opened (journal `review_link_opened`). */
  linkOpened: boolean;
  /** A claim was opened after the handover. */
  claimAfterHandover: boolean;
  /** At least one REVIEW_URL_* is set. */
  linksConfigured: boolean;
  /** The client has an unblocked messenger binding (the reminder never goes by SMS). */
  hasMessenger: boolean;
}

export type ReviewReminderVerdict =
  | 'due'
  | 'off'
  | 'no_links'
  | 'not_completed'
  | 'not_yet'
  | 'too_late'
  | 'link_opened'
  | 'claim'
  | 'no_messenger';

/**
 * One reminder `reviews.reminder_days` after `completed` (docs/reviews.md): only while the order
 * is still completed, no review link of it was opened, no claim was opened after the handover,
 * a review link is configured and the client has a messenger. It never changes the order.
 */
export function reviewReminderVerdict(facts: ReviewReminderFacts): ReviewReminderVerdict {
  if (!Number.isSafeInteger(facts.reminderDays) || facts.reminderDays <= 0) return 'off';
  if (!facts.linksConfigured) return 'no_links';
  if (facts.status !== 'completed' || facts.completedAt === null) return 'not_completed';
  const dueAt = facts.completedAt.getTime() + facts.reminderDays * DAY_MS;
  if (facts.now.getTime() < dueAt) return 'not_yet';
  if (facts.now.getTime() > dueAt + REVIEW_REMINDER_GRACE_DAYS * DAY_MS) return 'too_late';
  if (facts.linkOpened) return 'link_opened';
  if (facts.claimAfterHandover) return 'claim';
  if (!facts.hasMessenger) return 'no_messenger';
  return 'due';
}

export function reviewReminderDue(facts: ReviewReminderFacts): boolean {
  return reviewReminderVerdict(facts) === 'due';
}
