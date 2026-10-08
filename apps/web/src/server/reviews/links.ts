/**
 * Review links of the site (step 3, docs/reviews.md). Only platforms with REVIEW_URL_* set exist;
 * with neither set there is nothing to show anywhere.
 *
 * - The order page card «Оцените нас» links to our redirect /o/<token>/review/<platform>: it
 *   journals the first open and sends the client on with 302 (server/reviews/redirect.ts).
 * - /review (the QR of the counter sign, public, no personal data) links to the cards directly:
 *   there is no order to count against.
 */
import { reviewPlatforms, reviewUrls, type Env } from '@detaly/config';
import {
  REVIEW_BUTTON_TEXTS,
  REVIEW_PLATFORM_LABELS,
  reviewRedirectPath,
  type ReviewPlatform,
} from '@detaly/domain';

export type ReviewEnv = Pick<Env, 'REVIEW_URL_YANDEX' | 'REVIEW_URL_2GIS'>;

export interface ReviewLink {
  platform: ReviewPlatform;
  /** «Яндекс Карты», «2ГИС». */
  label: string;
  /** «Отзыв в Яндекс Картах», «Отзыв в 2ГИС». */
  buttonText: string;
  href: string;
}

function link(platform: ReviewPlatform, href: string): ReviewLink {
  return {
    platform,
    label: REVIEW_PLATFORM_LABELS[platform],
    buttonText: REVIEW_BUTTON_TEXTS[platform],
    href,
  };
}

/** The buttons of an order: our redirect under /o/<token>. */
export function orderReviewLinks(env: ReviewEnv, token: string): ReviewLink[] {
  return reviewPlatforms(env).map((platform) =>
    link(platform, reviewRedirectPath(`/o/${token}`, platform)),
  );
}

/** The buttons of /review: the configured cards themselves (no tracking on a public page). */
export function publicReviewLinks(env: ReviewEnv): ReviewLink[] {
  const urls = reviewUrls(env);
  return reviewPlatforms(env).flatMap((platform) => {
    const url = urls[platform];
    return url ? [link(platform, url)] : [];
  });
}
