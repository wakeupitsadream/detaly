/**
 * POST /api/admin/reviews (step 3, docs/reviews.md): «Сохранить» of the rating snapshot on
 * /admin/reviews. The numbers the owner read off the cards (parseSnapshotForm) go to settings
 * `reviews.snapshot` through the audited settings writer of step 2 (settings-writer.ts): the
 * optimistic version (409 when another tab saved meanwhile), updated_by 'admin' and a
 * settings_audit row with the old and the new value. After the commit the rating cache of this
 * process is dropped, so the storefront shows the new numbers at once.
 *
 * Order of checks as in the other admin handlers: Basic auth -> Origin (403) -> urlencoded body
 * (400/413) -> action (400) -> values (422) -> version (409).
 */
import type { Env } from '@detaly/config';
import type { Database } from '@detaly/db';
import {
  formatDayMonth,
  formatRatingX10,
  localDate,
  parseReviewSnapshot,
  REVIEW_PLATFORM_LABELS,
  REVIEW_PLATFORMS,
  REVIEW_SNAPSHOT_KEY,
  sameReviewSnapshot,
  type ReviewSnapshot,
} from '@detaly/domain';
import { readBoundedText } from '../body';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { formField } from './form-fields';
import { adminAuthFailure, adminDone, adminPage } from './http';
import { parseSnapshotForm } from './reviews';
import { writeAuditedSetting } from './settings-writer';

export const MAX_ADMIN_REVIEWS_BODY_BYTES = 4 * 1024;

export interface AdminReviewsDeps {
  db: Database;
  env: Pick<Env, 'ADMIN_BASIC_AUTH' | 'APP_BASE_URL'>;
  /** Drops the rating cache of this process (RatingReader.invalidate). */
  invalidateRating?: () => void;
  logger?: {
    info(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
  now?: () => Date;
}

const BACK = { href: '/admin/reviews', label: 'К отзывам' };

/** «Яндекс Карты 4,9 · 37, 2ГИС 4,8 · 12, на 20 октября»; «без оценок, на …» when empty. */
export function snapshotSummary(snapshot: ReviewSnapshot): string {
  const parts = REVIEW_PLATFORMS.flatMap((platform) => {
    const rating = snapshot.ratings[platform];
    return rating
      ? [
          `${REVIEW_PLATFORM_LABELS[platform]} ${formatRatingX10(rating.ratingX10)} · ${rating.count}`,
        ]
      : [];
  });
  return `${parts.length > 0 ? parts.join(', ') : 'без оценок'}, на ${formatDayMonth(snapshot.asOf)}`;
}

export async function handleAdminReviewsAction(
  request: Request,
  deps: AdminReviewsDeps,
): Promise<Response> {
  try {
    return await handle(request, deps);
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    deps.logger?.error({ ...errorInfo(error) }, 'admin reviews action failed');
    return adminPage(500, 'Не удалось сохранить — попробуйте ещё раз', BACK);
  }
}

async function handle(request: Request, deps: AdminReviewsDeps): Promise<Response> {
  const denied = adminAuthFailure(request, deps.env);
  if (denied) return denied;
  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return adminPage(
      403,
      'Запрос отклонён: форма открыта не с этого сайта. Обновите страницу',
      BACK,
    );
  }
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('application/x-www-form-urlencoded')) {
    return adminPage(400, 'Не удалось прочитать форму', BACK);
  }
  const body = await readBoundedText(request, MAX_ADMIN_REVIEWS_BODY_BYTES);
  if (!body.ok) return adminPage(413, 'Форма слишком большая', BACK);
  const form = new URLSearchParams(body.text);
  if (formField(form, 'action', 16) !== 'save') return adminPage(400, 'Неизвестное действие', BACK);
  const now = (deps.now ?? (() => new Date()))();
  const parsed = parseSnapshotForm(form, localDate(now));
  if (!parsed.ok) return adminPage(422, parsed.errors.join('. '), BACK);
  const next = parsed.snapshot;

  const outcome = await writeAuditedSetting(deps.db, {
    key: REVIEW_SNAPSHOT_KEY,
    value: next,
    version: formField(form, 'version', 64),
    same: (stored) => sameReviewSnapshot(parseReviewSnapshot(stored), next),
    at: now,
  });
  deps.logger?.info(
    { action: 'save', outcome, platforms: Object.keys(next.ratings).length },
    'admin reviews action',
  );
  if (outcome === 'conflict') {
    return adminPage(
      409,
      'Рейтинг уже изменили (в другой вкладке?) — откройте страницу заново и проверьте',
      BACK,
    );
  }
  if (outcome === 'unchanged') return adminDone('/admin/reviews', 'Без изменений');
  deps.invalidateRating?.();
  return adminDone('/admin/reviews', `Сохранено: ${snapshotSummary(next)}`);
}
