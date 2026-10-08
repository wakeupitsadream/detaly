/**
 * Review links of the shop's own cards in the map services (REVIEW_URL_YANDEX, REVIEW_URL_2GIS;
 * step 3, docs/reviews.md). Web and the worker decide here which platforms are offered: a
 * platform without its link does not exist anywhere, and with neither link the whole feature is
 * off (the messages stay as before, /review answers 404, no rating line).
 */
import { REVIEW_PLATFORMS, type ReviewPlatform } from '@detaly/domain/statuses';
import type { Env } from './env';

export type ReviewUrls = Readonly<Record<ReviewPlatform, string | null>>;

type ReviewEnv = Pick<Env, 'REVIEW_URL_YANDEX' | 'REVIEW_URL_2GIS'>;

export function reviewUrls(env: ReviewEnv): ReviewUrls {
  return { yandex: env.REVIEW_URL_YANDEX ?? null, '2gis': env.REVIEW_URL_2GIS ?? null };
}

/** Platforms with a link, in REVIEW_PLATFORMS order; [] when the feature is off. */
export function reviewPlatforms(env: ReviewEnv): ReviewPlatform[] {
  const urls = reviewUrls(env);
  return REVIEW_PLATFORMS.filter((platform) => urls[platform] !== null);
}
