/**
 * POST /api/admin/rossko (step 8, docs/rossko-automation.md): the settings of /admin/rossko, each
 * saved through the audited settings writer (settings-writer.ts: the optimistic version — 409 when
 * another tab saved meanwhile —, nothing written for an equal value, a settings_audit row):
 *
 * - `action=map` — the GetOrders status map: pairs of `code` / `act` (an empty act leaves the code
 *   unmapped: nothing is done on it but one alert);
 * - `action=poll` — `enabled=on|off`: the polling switch (it runs only with ROSSKO_MODE=live; the
 *   page warns, the switch itself is stored anyway, so it is ready when the keys arrive);
 * - `action=within` — `minutes`: «Не заказано у поставщика» after that much working time;
 * - `action=max_total` — `rub`: the shadow auto-order limit of the order total;
 * - `action=cutoffs` — `times`: the Rossko cutoff times «11:00, 16:00» ('' clears them).
 *
 * There is no switch of the real auto-order anywhere (PLAN decision 7). Order of checks as in the
 * other admin handlers: Basic auth (401/404) -> Origin (403) -> urlencoded body (400/413) -> action
 * (400) -> fields (422) -> the write (409 on a conflict). Done: 303 back with `?done=`. Logs: the
 * action and the outcome.
 */
import type { Env } from '@detaly/config';
import type { Database } from '@detaly/db';
import {
  AUTO_ORDER_MAX_TOTAL_KEY,
  AUTO_ORDER_MAX_TOTAL_LIMIT_KOP,
  formatRub,
  isAutoOrderMaxTotalKop,
  isRosskoOrderWithinMinutes,
  parseCutoffText,
  parseCutoffTimes,
  parseRosskoStatusMap,
  ROSSKO_CUTOFF_TIMES_KEY,
  ROSSKO_CUTOFF_TIMES_MAX,
  ROSSKO_ORDER_WITHIN_KEY,
  ROSSKO_ORDER_WITHIN_MAX_MINUTES,
  ROSSKO_ORDER_WITHIN_MIN_MINUTES,
  ROSSKO_POLL_ENABLED_KEY,
  ROSSKO_STATUS_MAP_KEY,
  sameRosskoStatusMap,
  workingTimeText,
} from '@detaly/domain';
import { readBoundedText } from '../body';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { formField, parseRubToKop } from './form-fields';
import { adminAuthFailure, adminDone, adminPage } from './http';
import { ADMIN_ROSSKO_PATH, statusMapFromForm } from './rossko';
import { writeAuditedSetting, type AuditedWriteOutcome } from './settings-writer';

export const MAX_ADMIN_ROSSKO_BODY_BYTES = 8 * 1024;
export const ADMIN_ROSSKO_ACTIONS = ['map', 'poll', 'within', 'max_total', 'cutoffs'] as const;
export type AdminRosskoAction = (typeof ADMIN_ROSSKO_ACTIONS)[number];

export interface AdminRosskoDeps {
  db: Database;
  env: Pick<Env, 'ADMIN_BASIC_AUTH' | 'APP_BASE_URL' | 'ROSSKO_MODE'>;
  logger?: {
    info(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
  now?: () => Date;
}

const BACK = { href: ADMIN_ROSSKO_PATH, label: 'К настройкам Rossko' };

export async function handleAdminRosskoAction(
  request: Request,
  deps: AdminRosskoDeps,
): Promise<Response> {
  try {
    return await handle(request, deps);
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    deps.logger?.error(errorInfo(error), 'admin rossko action failed');
    return adminPage(500, 'Не удалось сохранить — попробуйте ещё раз', BACK);
  }
}

async function handle(request: Request, deps: AdminRosskoDeps): Promise<Response> {
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
  const body = await readBoundedText(request, MAX_ADMIN_ROSSKO_BODY_BYTES);
  if (!body.ok) return adminPage(413, 'Форма слишком большая', BACK);
  const form = new URLSearchParams(body.text);
  const action = formField(form, 'action', 16);
  if (!(ADMIN_ROSSKO_ACTIONS as readonly string[]).includes(action)) {
    return adminPage(400, 'Неизвестное действие', BACK);
  }
  const now = (deps.now ?? (() => new Date()))();
  const version = formField(form, 'version', 64);

  /** The audited write and its answer: 409 page, «Без изменений» or the saved message. */
  const save = async (
    key: string,
    value: unknown,
    same: (stored: unknown) => boolean,
    savedMessage: string,
  ): Promise<Response> => {
    const outcome: AuditedWriteOutcome = await writeAuditedSetting(deps.db, {
      key,
      value,
      version,
      same,
      at: now,
    });
    deps.logger?.info({ action, outcome }, 'admin rossko action');
    if (outcome === 'conflict') {
      return adminPage(
        409,
        'Настройку уже изменили (в другой вкладке?) — откройте страницу заново и проверьте',
        BACK,
      );
    }
    return adminDone(ADMIN_ROSSKO_PATH, outcome === 'unchanged' ? 'Без изменений' : savedMessage);
  };

  switch (action as AdminRosskoAction) {
    case 'map': {
      const parsed = statusMapFromForm(form);
      if (!parsed.ok) return adminPage(422, parsed.message, BACK);
      const { map } = parsed;
      const count = Object.keys(map).length;
      return save(
        ROSSKO_STATUS_MAP_KEY,
        map,
        (stored) => {
          const current = parseRosskoStatusMap(stored);
          return current !== null && sameRosskoStatusMap(current, map);
        },
        count === 0 ? 'Коды статусов очищены' : `Коды статусов сохранены: ${count}`,
      );
    }
    case 'poll': {
      const raw = formField(form, 'enabled', 3);
      if (raw !== 'on' && raw !== 'off')
        return adminPage(422, 'Выберите: включён или выключен', BACK);
      const enabled = raw === 'on';
      const message = enabled
        ? deps.env.ROSSKO_MODE === 'live'
          ? 'Опрос Rossko включён: заказы проверяются каждые 20 минут'
          : 'Опрос Rossko включён, но работать начнёт только с ROSSKO_MODE=live (ключи Rossko)'
        : 'Опрос Rossko выключен';
      return save(ROSSKO_POLL_ENABLED_KEY, enabled, (stored) => stored === enabled, message);
    }
    case 'within': {
      const raw = formField(form, 'minutes', 8);
      const minutes = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
      if (!isRosskoOrderWithinMinutes(minutes)) {
        return adminPage(
          422,
          `Срок — целое число минут от ${ROSSKO_ORDER_WITHIN_MIN_MINUTES} до ${ROSSKO_ORDER_WITHIN_MAX_MINUTES}`,
          BACK,
        );
      }
      return save(
        ROSSKO_ORDER_WITHIN_KEY,
        minutes,
        (stored) => stored === minutes,
        `«Не заказано у поставщика» — после ${workingTimeText(minutes)} рабочего времени`,
      );
    }
    case 'max_total': {
      const kop = parseRubToKop(formField(form, 'rub', 16));
      if (kop === null || !isAutoOrderMaxTotalKop(kop)) {
        return adminPage(
          422,
          `Порог — сумма в рублях от 0 до ${formatRub(AUTO_ORDER_MAX_TOTAL_LIMIT_KOP)}`,
          BACK,
        );
      }
      return save(
        AUTO_ORDER_MAX_TOTAL_KEY,
        kop,
        (stored) => stored === kop,
        `Порог теневого автозаказа: ${formatRub(kop)}`,
      );
    }
    case 'cutoffs': {
      const times = parseCutoffText(formField(form, 'times', 200));
      if (times === null) {
        return adminPage(
          422,
          `Время отсечки — ЧЧ:ММ через запятую, не больше ${ROSSKO_CUTOFF_TIMES_MAX}: например «11:00, 16:00»`,
          BACK,
        );
      }
      return save(
        ROSSKO_CUTOFF_TIMES_KEY,
        times,
        (stored) => {
          const current = parseCutoffTimes(stored);
          return current !== null && current.join(',') === times.join(',');
        },
        times.length === 0 ? 'Отсечки Rossko очищены' : `Отсечки Rossko: ${times.join(', ')}`,
      );
    }
  }
}
