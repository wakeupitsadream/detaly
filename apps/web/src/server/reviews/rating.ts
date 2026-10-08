/**
 * The storefront rating line «★ 4,9 на Яндекс Картах · 37 отзывов» (home, /search; step 3,
 * docs/reviews.md). The numbers are the snapshot the owner saved on /admin/reviews (settings
 * `reviews.snapshot`; the map services have no public API), shown only under the rules of
 * ratingBlock: the platform's review link set, at least `reviews.min_count` reviews, a snapshot
 * at most `reviews.max_age_days` old.
 *
 * Read with the other settings rules: cached for a minute, dropped by the admin after a save; a
 * database failure keeps the last good values or hides the line. DEMO_MODE has no database and
 * so no snapshot: the line is never shown there — a made-up rating on a public page would be
 * misleading advertising.
 */
import { reviewPlatforms, reviewUrls, settingsDefaultsFromEnv, type Env } from '@detaly/config';
import type { Database } from '@detaly/db';
import {
  localDate,
  parseReviewSnapshot,
  ratingBlock,
  REVIEW_SNAPSHOT_KEY,
  type RatingBlock,
  type ReviewSnapshot,
  type SettingsValues,
} from '@detaly/domain';
import { getDb } from '../db';
import { serverEnv } from '../env';
import { singleton } from '../globals';
import { getLogger } from '../logger';
import { isDemoMode } from '../mode';

export const RATING_TTL_MS = 60_000;

export interface RatingSettings {
  snapshot: ReviewSnapshot | null;
  /** reviews.min_count */
  minCount: number;
  /** reviews.max_age_days */
  maxAgeDays: number;
}

const KEYS = [REVIEW_SNAPSHOT_KEY, 'reviews.min_count', 'reviews.max_age_days'] as const;

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Raw `settings` rows over the defaults; a malformed value falls back (the snapshot: none). */
export function resolveRatingSettings(
  rows: ReadonlyMap<string, unknown>,
  env: Env,
): RatingSettings {
  const defaults = settingsDefaultsFromEnv(env);
  const pick = <K extends keyof SettingsValues>(key: K): number => {
    const value = rows.get(key);
    return isNonNegativeInt(value) ? value : (defaults[key] as number);
  };
  return {
    snapshot: parseReviewSnapshot(rows.get(REVIEW_SNAPSHOT_KEY)),
    minCount: pick('reviews.min_count'),
    maxAgeDays: pick('reviews.max_age_days'),
  };
}

export interface RatingReader {
  /** null: no values (the database failed before anything was cached). */
  get(): Promise<RatingSettings | null>;
  /** The admin saved a snapshot: the next get() reads the database. */
  invalidate(): void;
}

export interface RatingReaderOptions {
  db: Database;
  env: Env;
  ttlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export function createRatingReader({
  db,
  env,
  ttlMs = RATING_TTL_MS,
  now = Date.now,
  onError,
}: RatingReaderOptions): RatingReader {
  let cached: { value: RatingSettings; at: number } | null = null;
  let inflight: Promise<RatingSettings | null> | null = null;
  let generation = 0;

  async function load(started: number): Promise<RatingSettings | null> {
    try {
      const rows = await db.query.settings.findMany({
        columns: { key: true, value: true },
        where: (t, { inArray }) => inArray(t.key, [...KEYS]),
      });
      const value = resolveRatingSettings(
        new Map(rows.map((row) => [row.key, row.value as unknown])),
        env,
      );
      if (started === generation) cached = { value, at: now() };
      return value;
    } catch (error) {
      onError?.(error);
      return cached?.value ?? null;
    }
  }

  return {
    get() {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
      if (inflight === null) {
        const pending = load(generation).finally(() => {
          if (inflight === pending) inflight = null;
        });
        inflight = pending;
      }
      return inflight;
    },
    invalidate() {
      generation += 1;
      if (cached) cached = { value: cached.value, at: Number.NEGATIVE_INFINITY };
      inflight = null;
    },
  };
}

/** The reader of this process; DEMO_MODE never has one (no database, no snapshot). */
export function getRatingReader(): RatingReader | null {
  if (isDemoMode()) return null;
  return singleton('rating-reader', () =>
    createRatingReader({
      db: getDb(),
      env: serverEnv(),
      onError: (error) =>
        getLogger().warn(
          { err: error instanceof Error ? error.name : typeof error },
          'rating settings unavailable',
        ),
    }),
  );
}

/** What the storefront shows now, or null (no link, no snapshot, too few, too old, demo). */
export async function storefrontRating(now: Date = new Date()): Promise<RatingBlock | null> {
  const env = serverEnv();
  // No review link: nothing to show and nothing to read.
  if (env.DEMO_MODE || reviewPlatforms(env).length === 0) return null;
  const settings = await getRatingReader()?.get();
  if (!settings) return null;
  return ratingBlock(settings.snapshot, {
    urls: reviewUrls(env),
    minCount: settings.minCount,
    maxAgeDays: settings.maxAgeDays,
    today: localDate(now),
  });
}
