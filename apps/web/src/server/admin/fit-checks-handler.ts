/**
 * POST /api/admin/fit-checks (step 4, docs/fit-check.md): the admin side of fit checks.
 *
 * - answer: «Подходит», «Не подходит», «Нужен звонок» for a line still waiting — the fallback
 *   when Telegram is down (answered_by stays null: «админка»); only a pending line changes, the
 *   sellers card is redrawn through the outbox (notify/fit refresh);
 * - analog: «БРЕНД АРТИКУЛ», found and priced exactly as the bot does (resolveFitAnalog through
 *   the supplier cache and limiter, priceOffer) or refused with the same words («Не нашёл у
 *   поставщика — проверьте артикул»);
 * - sla: settings `fit_check.sla_minutes` (5…1440) through the audited settings writer of step 2
 *   (optimistic version, a settings_audit row).
 *
 * Order of checks as in the other admin handlers: Basic auth (401/404) -> Origin (403) ->
 * urlencoded body (400/413) -> action (400) -> fields (422) -> state (404/409). Done: 303 back with
 * `?done=`. Logs: the request id, the line id, the action and the outcome.
 */
import type { Env } from '@detaly/config';
import type { Database, Executor } from '@detaly/db';
import {
  FIT_CHECK_ANSWER_LABELS,
  FIT_CHECK_SLA_KEY,
  FIT_CHECK_SLA_MAX_MINUTES,
  FIT_CHECK_SLA_MIN_MINUTES,
  FIT_CHECK_STATUS_LABELS,
  type FitCheckAnswer,
} from '@detaly/domain';
import type { RosskoClient } from '@detaly/rossko';
import {
  answerFitAnalog,
  answerFitCheck,
  enqueueFitNotify,
  fitRefreshKey,
  isFitSlaMinutes,
  loadFitCheck,
  resolveFitAnalog,
  type FitAnswerResult,
} from '@detaly/vin';
import { readBoundedText } from '../body';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import type { SearchSettings } from '../settings';
import { formField } from './form-fields';
import { adminAuthFailure, adminDone, adminPage } from './http';
import { isUuid } from './queries';
import { writeAuditedSetting } from './settings-writer';
import { vinSearchOf } from './vin-actions-handler';

export const MAX_ADMIN_FIT_BODY_BYTES = 4 * 1024;
export const ADMIN_FIT_PATH = '/admin/fit-checks';
export const ADMIN_FIT_ACTIONS = ['answer', 'analog', 'sla'] as const;
export type AdminFitAction = (typeof ADMIN_FIT_ACTIONS)[number];

/** The answers of the «answer» action («Аналог» has its own form with the article). */
const PLAIN_ANSWERS = ['fits', 'not_fit', 'call_needed'] as const satisfies readonly Exclude<
  FitCheckAnswer,
  'analog'
>[];

export interface AdminFitDeps {
  db: Database;
  env: Pick<Env, 'ADMIN_BASIC_AUTH' | 'APP_BASE_URL'>;
  supplier: {
    rossko: Pick<RosskoClient, 'search'>;
    settings: { get(): Promise<SearchSettings> };
  };
  logger?: {
    info(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
  now?: () => Date;
  /** Wakes the outbox dispatcher after an answer (the card redraw). */
  nudge?: () => void;
}

const BACK = { href: ADMIN_FIT_PATH, label: 'К проверкам' };

function refusalMessage(result: Exclude<FitAnswerResult, { ok: true }>): string {
  return result.reason === 'not_found'
    ? 'Проверка не найдена'
    : `Уже отвечено: ${FIT_CHECK_STATUS_LABELS[result.status]}`;
}

export async function handleAdminFitAction(
  request: Request,
  deps: AdminFitDeps,
): Promise<Response> {
  try {
    return await handle(request, deps);
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    deps.logger?.error(errorInfo(error), 'admin fit action failed');
    return adminPage(500, 'Ошибка сервера, попробуйте ещё раз', BACK);
  }
}

async function handle(request: Request, deps: AdminFitDeps): Promise<Response> {
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
  const body = await readBoundedText(request, MAX_ADMIN_FIT_BODY_BYTES);
  if (!body.ok) return adminPage(413, 'Форма слишком большая', BACK);
  const form = new URLSearchParams(body.text);
  const action = formField(form, 'action', 16);
  if (!(ADMIN_FIT_ACTIONS as readonly string[]).includes(action)) {
    return adminPage(400, 'Неизвестное действие', BACK);
  }
  const now = (deps.now ?? (() => new Date()))();

  if (action === 'sla') {
    const raw = formField(form, 'minutes', 8);
    const minutes = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!isFitSlaMinutes(minutes)) {
      return adminPage(
        422,
        `Срок ответа — целое число минут от ${FIT_CHECK_SLA_MIN_MINUTES} до ${FIT_CHECK_SLA_MAX_MINUTES}`,
        BACK,
      );
    }
    const outcome = await writeAuditedSetting(deps.db, {
      key: FIT_CHECK_SLA_KEY,
      value: minutes,
      version: formField(form, 'version', 64),
      same: (stored) => stored === minutes,
      at: now,
    });
    deps.logger?.info({ action, outcome, minutes }, 'admin fit action');
    if (outcome === 'conflict') {
      return adminPage(
        409,
        'Срок уже изменили (в другой вкладке?) — откройте страницу заново и проверьте',
        BACK,
      );
    }
    return adminDone(
      ADMIN_FIT_PATH,
      outcome === 'unchanged' ? 'Без изменений' : `Срок ответа: ${minutes} мин рабочего времени`,
    );
  }

  const id = formField(form, 'id', 64);
  if (!isUuid(id)) return adminPage(404, 'Проверка не найдена', BACK);
  const check = await loadFitCheck(deps.db, id);
  if (check === null) return adminPage(404, 'Проверка не найдена', BACK);
  const log = (ok: boolean, extra: Record<string, unknown> = {}) =>
    deps.logger?.info(
      { fitRequestId: check.requestId, fitCheckId: check.id, action, ok, ...extra },
      'admin fit action',
    );

  // The answer and the card redraw in one transaction: the card never misses an answer.
  const answerWith = (write: (tx: Executor) => Promise<FitAnswerResult>) =>
    deps.db.transaction(async (tx) => {
      const result = await write(tx);
      if (result.ok) {
        await enqueueFitNotify(tx, {
          requestId: check.requestId,
          kind: 'refresh',
          key: fitRefreshKey(check.requestId, check.id),
        });
      }
      return result;
    });

  if (action === 'answer') {
    const answer = formField(form, 'answer', 16);
    if (!(PLAIN_ANSWERS as readonly string[]).includes(answer)) {
      return adminPage(400, 'Неизвестный ответ', BACK);
    }
    const plain = answer as (typeof PLAIN_ANSWERS)[number];
    const result = await answerWith((tx) =>
      answerFitCheck(tx, { id, answer: plain, staffId: null, now }),
    );
    log(result.ok, { answer: plain });
    if (!result.ok) return adminPage(409, refusalMessage(result), BACK);
    nudge(deps);
    return adminDone(
      ADMIN_FIT_PATH,
      `${check.brand} ${check.article}: ${FIT_CHECK_ANSWER_LABELS[plain]}`,
    );
  }

  // action === 'analog'
  const text = formField(form, 'text', 200);
  if (text === '') return adminPage(422, 'Напишите аналог: «БРЕНД АРТИКУЛ»', BACK);
  if (check.status !== 'pending') {
    return adminPage(
      409,
      `Уже отвечено: ${FIT_CHECK_STATUS_LABELS[check.status as keyof typeof FIT_CHECK_STATUS_LABELS]}`,
      BACK,
    );
  }
  const settings = await deps.supplier.settings.get();
  if (!settings.fromDatabase) {
    return adminPage(503, 'Не удалось загрузить настройки цен — попробуйте через минуту', BACK);
  }
  const resolved = await resolveFitAnalog({
    text,
    original: { brand: check.brand, article: check.article },
    search: vinSearchOf(deps.supplier.rossko),
    pricing: settings.pricing,
    excludedRules: settings.excludedRules,
    eta: settings.eta,
    now,
  });
  if (!resolved.ok) {
    log(false, { reason: resolved.reason });
    return adminPage(422, resolved.message, BACK);
  }
  const { brand, article, name, offer } = resolved.analog;
  const result = await answerWith((tx) =>
    answerFitAnalog(tx, { id, analog: { brand, article, name, offer }, staffId: null, now }),
  );
  log(result.ok, { answer: 'analog' });
  if (!result.ok) return adminPage(409, refusalMessage(result), BACK);
  nudge(deps);
  return adminDone(ADMIN_FIT_PATH, `${check.brand} ${check.article}: аналог ${brand} ${article}`);
}

function nudge(deps: AdminFitDeps): void {
  try {
    deps.nudge?.();
  } catch {
    // best effort: the dispatcher polls anyway
  }
}
