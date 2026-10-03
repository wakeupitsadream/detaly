/**
 * POST /api/admin/vin/<id>/actions (docs/phase-1c-implementation.md decisions С13, С26): the
 * admin side of a VIN request, as the owner.
 *
 * - take: «Взять в работу» (new -> in_work);
 * - preview: the master's answer as lines «БРЕНД АРТИКУЛ [КОЛ-ВО] [# заметка]» and '>' comment
 *   lines, checked by GetSearch through the 15-minute cache and the shared limiter
 *   (previewVinAnswer), saved with its preview: every line is shown with its price and date or
 *   its error;
 * - send: «Отправить клиенту» — only a preview without errors (409 otherwise): the proposal cart
 *   (/p/<token>, 7 days) and vin_proposal to the client through the outbox;
 * - close: «Закрыть» with a reason for the record.
 *
 * Order of checks: Basic auth (401/404) -> Origin (403) -> id (404) -> urlencoded body (400).
 * Done: 303 back to the card with `?done=`. Logs: the request id, the action and counts.
 */
import type { Env } from '@detaly/config';
import { vinRequests, eq, type Database } from '@detaly/db';
import { searchFailure, type RosskoClient } from '@detaly/rossko';
import {
  closeVinRequest,
  previewVinAnswer,
  saveVinPreview,
  sendVinProposal,
  takeVinRequest,
  VIN_ANSWER_TEXT_MAX,
  VIN_CLOSE_REASON_MAX,
  type VinSearch,
} from '@detaly/vin';
import { readBoundedText } from '../body';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import type { SearchSettings } from '../settings';
import { formField } from './form-fields';
import { adminAuthFailure, adminDone, adminPage } from './http';
import { isUuid } from './queries';

/** The answer (up to VIN_ANSWER_TEXT_MAX characters) and a few short fields. */
export const MAX_ADMIN_VIN_BODY_BYTES = 64 * 1024;

export const ADMIN_VIN_ACTIONS = ['take', 'preview', 'send', 'close'] as const;
export type AdminVinAction = (typeof ADMIN_VIN_ACTIONS)[number];

export interface AdminVinDeps {
  db: Database;
  env: Env;
  supplier: {
    rossko: Pick<RosskoClient, 'search'>;
    settings: { get(): Promise<SearchSettings> };
  };
  logger?: {
    info(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
  now?: () => Date;
  /** Wakes the outbox dispatcher after «Отправить клиенту». */
  nudge?: () => void;
}

export function vinCardPath(id: string): string {
  return `/admin/vin/${id}`;
}

/**
 * GetSearch of one article for the preview: through the cache and the limiter (priority
 * `search`, the quota breaker applies). An error answer throws, so only that line becomes
 * `supplier_unavailable`; Rossko's «not found» is an empty list.
 */
export function vinSearchOf(rossko: Pick<RosskoClient, 'search'>): VinSearch {
  return async (articleNorm) => {
    const result = await rossko.search(articleNorm, { priority: 'search' });
    if (result.offers.length === 0) {
      const failure = searchFailure({ success: false, message: result.message });
      if (failure !== null) throw new Error(failure);
    }
    return result.offers;
  };
}

const SEND_REFUSALS = {
  not_found: { status: 404, message: 'Заявка не найдена' },
  has_errors: {
    status: 409,
    message:
      'В ответе есть ошибки — «Отправить клиенту» недоступна. Исправьте строки и проверьте снова',
  },
  empty: { status: 409, message: 'Сначала напишите ответ строками и нажмите «Проверить»' },
  closed: { status: 409, message: 'Заявка закрыта или уже оформлена' },
} as const;

const REFUSALS = {
  not_found: 'Заявка не найдена',
  closed: 'Заявка закрыта',
  converted: 'Заявка уже оформлена клиентом',
} as const;

export async function handleAdminVinAction(
  request: Request,
  id: string,
  deps: AdminVinDeps,
): Promise<Response> {
  const denied = adminAuthFailure(request, deps.env);
  if (denied) return denied;
  const list = { href: '/admin/vin', label: 'К заявкам' };
  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return adminPage(
      403,
      'Запрос отклонён: форма открыта не с этого сайта. Обновите страницу',
      list,
    );
  }
  if (!isUuid(id)) return adminPage(404, 'Заявка не найдена', list);
  const back = { href: vinCardPath(id), label: 'Вернуться к заявке' };
  const now = deps.now ?? (() => new Date());

  try {
    const type = (request.headers.get('content-type') ?? '').toLowerCase();
    if (!type.includes('application/x-www-form-urlencoded')) {
      return adminPage(400, 'Не удалось прочитать форму', back);
    }
    const body = await readBoundedText(request, MAX_ADMIN_VIN_BODY_BYTES);
    if (!body.ok) return adminPage(413, 'Ответ слишком длинный', back);
    const form = new URLSearchParams(body.text);
    const action = formField(form, 'action', 16);
    if (!(ADMIN_VIN_ACTIONS as readonly string[]).includes(action)) {
      return adminPage(400, 'Неизвестное действие', back);
    }
    const [exists] = await deps.db
      .select({ id: vinRequests.id })
      .from(vinRequests)
      .where(eq(vinRequests.id, id));
    if (!exists) return adminPage(404, 'Заявка не найдена', list);
    const log = (ok: boolean, extra: Record<string, unknown> = {}) =>
      deps.logger?.info({ vinRequest: id, action, ok, ...extra }, 'admin vin action');

    switch (action as AdminVinAction) {
      case 'take': {
        const result = await takeVinRequest(deps.db, { id, staffId: null, now: now() });
        log(result.ok);
        return result.ok
          ? adminDone(vinCardPath(id), 'Заявка в работе')
          : adminPage(409, REFUSALS[result.reason], back);
      }
      case 'preview': {
        const answer = (form.get('answer') ?? '').replace(/\r\n/g, '\n').trim();
        if (answer === '')
          return adminPage(422, 'Напишите ответ строками: БРЕНД АРТИКУЛ КОЛ-ВО', back);
        if (answer.length > VIN_ANSWER_TEXT_MAX) {
          return adminPage(422, `Ответ — до ${VIN_ANSWER_TEXT_MAX} символов`, back);
        }
        const settings = await deps.supplier.settings.get();
        if (!settings.fromDatabase) {
          return adminPage(
            503,
            'Не удалось загрузить настройки цен — попробуйте через минуту',
            back,
          );
        }
        const preview = await previewVinAnswer({
          text: answer,
          search: vinSearchOf(deps.supplier.rossko),
          markupRules: settings.markupRules,
          excludedRules: settings.excludedRules,
          eta: settings.eta,
          now: now(),
        });
        const saved = await saveVinPreview(deps.db, {
          id,
          answerText: answer,
          preview,
          staffId: null,
          now: now(),
        });
        log(saved.ok, { lines: preview.lines.length, errors: preview.errorCount });
        if (!saved.ok) return adminPage(409, REFUSALS[saved.reason], back);
        return adminDone(
          vinCardPath(id),
          preview.errorCount > 0
            ? `Проверено: ошибок ${preview.errorCount} — исправьте строки`
            : `Проверено: ${preview.okCount} поз., ошибок нет — можно отправлять`,
        );
      }
      case 'send': {
        const result = await sendVinProposal(
          { db: deps.db, now, ...(deps.nudge ? { nudge: deps.nudge } : {}) },
          { id, staffId: null },
        );
        log(
          result.ok,
          result.ok ? { n: result.n, duplicate: result.duplicate } : { reason: result.reason },
        );
        if (!result.ok) {
          const refusal = SEND_REFUSALS[result.reason];
          return adminPage(refusal.status, refusal.message, back);
        }
        return adminDone(
          vinCardPath(id),
          result.duplicate ? 'Эта подборка уже отправлена клиенту' : 'Подборка отправлена клиенту',
        );
      }
      case 'close': {
        const reason = formField(form, 'reason', VIN_CLOSE_REASON_MAX);
        const result = await closeVinRequest(deps.db, {
          id,
          reason: reason === '' ? null : reason,
          now: now(),
        });
        log(result.ok);
        return result.ok
          ? adminDone(vinCardPath(id), 'Заявка закрыта')
          : adminPage(409, REFUSALS[result.reason], back);
      }
    }
  } catch (error) {
    deps.logger?.error(errorInfo(error), 'admin vin action failed');
    return adminPage(500, 'Ошибка сервера, попробуйте ещё раз', back);
  }
}
