/**
 * POST /api/orders/<token>/actions with JSON `{ action, itemId?, last4? }`
 * (docs/phase-1b-implementation.md 14.2, decision Б24). The client decides on /o/<token>:
 *
 * - `confirm` («Подтверждаю»), `approve` («Согласен»), `prepay_now` («Оплатить заранее»): the
 *   link token plus a confirmation step in the interface;
 * - `refund_request` («Вернуть деньги»), `refuse` («Отказаться от заказа»), `item_cancel`
 *   («Отменить позицию»): additionally the last 4 phone digits, with the failure counter shared
 *   with the 1A cancellation (digits.ts).
 *
 * Order of checks: Origin (403) -> token (404) -> body (400) -> action and fields (422) ->
 * order (404) -> for digit actions: attempt counter (429, 503 when Redis is down), digits under
 * the row lock (422 wrong_digits) -> performClientAction: the state machine (409 not_allowed)
 * -> 200. The IP rate limit (`order_action`) belongs to src/proxy.ts.
 * Logs carry the order number and the action only: no phone, no digits, no token, no IP.
 */
import type { Logger, Redis } from '@detaly/config';
import { performClientAction, type ClientAction, type EngineDeps } from '@detaly/orders';
import { readBoundedJson } from '../body';
import { errorInfo, isNamedError } from '../errors';
import { isSameOrigin } from '../request-guards';
import { isOrderToken } from './access';
import {
  digitsBlocked,
  DigitsUnavailableError,
  isLast4,
  verifyDigitsLocked,
  type DigitsCheck,
} from './digits';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const CLIENT_ACTIONS = [
  'confirm',
  'approve',
  'prepay_now',
  'refund_request',
  'refuse',
  'item_cancel',
] as const satisfies readonly ClientAction[];

/** Destructive actions: confirmed by the last 4 phone digits (decision Б24). */
export const DIGIT_ACTIONS: ReadonlySet<ClientAction> = new Set([
  'refund_request',
  'refuse',
  'item_cancel',
]);

export const ACTION_MESSAGES = {
  forbidden: 'Запрос отклонён. Обновите страницу и попробуйте ещё раз',
  notFound: 'Заказ не найден',
  badRequest: 'Не удалось прочитать запрос',
  validation: 'Проверьте данные и попробуйте ещё раз',
  digitsRequired: 'Введите последние 4 цифры телефона',
  wrongDigits: 'Цифры не совпадают с номером телефона из заказа',
  tooMany: 'Слишком много неверных попыток. Попробуйте позже или позвоните нам',
  notAllowed: 'Это действие уже недоступно — обновите страницу',
  unavailable: 'Сейчас не получается выполнить действие, попробуйте через минуту',
  internal: 'Ошибка сервера, попробуйте позже',
} as const;

/** Largest request body: `{"action":"item_cancel","itemId":"<uuid>","last4":"1234"}`. */
export const MAX_ACTION_BODY_BYTES = 512;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActionsHandlerDeps {
  engine: EngineDeps;
  redis: Redis;
  /** Prepended to Redis keys; tests use `test:<uuid>:`. */
  keyPrefix?: string;
  appBaseUrl: string;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

interface ParsedAction {
  action: ClientAction;
  itemId: string | null;
  last4: string | null;
}

function json(body: Record<string, unknown>, status: number, extra?: Record<string, string>) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

function isClientAction(value: unknown): value is ClientAction {
  return typeof value === 'string' && (CLIENT_ACTIONS as readonly string[]).includes(value);
}

type ParseResult =
  | { ok: true; value: ParsedAction }
  | { ok: false; status: 400 | 422; error: string; message: string };

async function parseBody(request: Request): Promise<ParseResult> {
  const bad = { ok: false, status: 400, error: 'bad_request', message: ACTION_MESSAGES.badRequest };
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) return bad as ParseResult;
  const body = await readBoundedJson(request, MAX_ACTION_BODY_BYTES);
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return bad as ParseResult;
  }
  const record = body as Record<string, unknown>;
  const invalid = (message: string): ParseResult => ({
    ok: false,
    status: 422,
    error: 'validation',
    message,
  });
  if (!isClientAction(record.action)) return invalid(ACTION_MESSAGES.validation);
  const action = record.action;
  let itemId: string | null = null;
  if (action === 'item_cancel') {
    if (typeof record.itemId !== 'string' || !UUID_RE.test(record.itemId)) {
      return invalid(ACTION_MESSAGES.validation);
    }
    itemId = record.itemId.toLowerCase();
  }
  let last4: string | null = null;
  if (DIGIT_ACTIONS.has(action)) {
    if (!isLast4(record.last4)) return invalid(ACTION_MESSAGES.digitsRequired);
    last4 = record.last4;
  }
  return { ok: true, value: { action, itemId, last4 } };
}

function digitsResponse(check: Exclude<DigitsCheck, { kind: 'ok' }>): Response {
  switch (check.kind) {
    case 'not_found':
      return json({ error: 'not_found', message: ACTION_MESSAGES.notFound }, 404);
    case 'too_many_attempts':
      return json({ error: 'too_many_attempts', message: ACTION_MESSAGES.tooMany }, 429, {
        'Retry-After': String(check.retryAfterSec),
      });
    case 'wrong_digits':
      return json(
        {
          error: 'wrong_digits',
          message: ACTION_MESSAGES.wrongDigits,
          attemptsLeft: check.attemptsLeft,
        },
        422,
      );
  }
}

export async function handleOrderAction(
  request: Request,
  token: string,
  deps: ActionsHandlerDeps,
): Promise<Response> {
  if (!isSameOrigin(request.headers, deps.appBaseUrl)) {
    return json({ error: 'forbidden_origin', message: ACTION_MESSAGES.forbidden }, 403);
  }
  if (!isOrderToken(token)) {
    return json({ error: 'not_found', message: ACTION_MESSAGES.notFound }, 404);
  }
  const parsed = await parseBody(request);
  if (!parsed.ok) return json({ error: parsed.error, message: parsed.message }, parsed.status);
  const { action, itemId, last4 } = parsed.value;
  const { engine, logger } = deps;

  try {
    const order = await engine.db.query.orders.findFirst({
      where: (t, ops) => ops.eq(t.accessToken, token),
      columns: { id: true, number: true, userId: true },
    });
    if (!order) return json({ error: 'not_found', message: ACTION_MESSAGES.notFound }, 404);

    if (last4 !== null) {
      const digits = { redis: deps.redis, keyPrefix: deps.keyPrefix ?? '', now: engine.now };
      const blocked = await digitsBlocked(digits, order.id);
      if (blocked) return digitsResponse(blocked);
      // The digits are compared under the row lock and the transaction commits before the
      // engine takes the lock again for the transition (performClientAction opens its own).
      const check = await engine.db.transaction((tx) =>
        verifyDigitsLocked(tx, digits, { orderId: order.id, last4 }),
      );
      if (check.kind !== 'ok') {
        if (check.kind !== 'not_found') {
          logger?.warn({ order: order.number, action, result: check.kind }, 'order action: digits');
        }
        return digitsResponse(check);
      }
    }

    const result = await performClientAction(engine, {
      orderId: order.id,
      userId: order.userId,
      action,
      ...(itemId !== null ? { itemId } : {}),
    });
    if (!result.ok) {
      if (result.reason === 'not_found') {
        return json({ error: 'not_found', message: ACTION_MESSAGES.notFound }, 404);
      }
      logger?.info(
        { order: order.number, action, reason: result.reason, failed: result.failed },
        'order action not allowed',
      );
      return json(
        { error: 'not_allowed', message: ACTION_MESSAGES.notAllowed, status: result.status },
        409,
      );
    }
    logger?.info({ order: order.number, action, from: result.from, to: result.to }, 'order action');
    return json({ status: result.to }, 200);
  } catch (error) {
    if (isNamedError(error, DigitsUnavailableError, 'DigitsUnavailableError')) {
      logger?.warn(errorInfo(error.cause), 'order action: attempt counter unavailable');
      return json({ error: 'unavailable', message: ACTION_MESSAGES.unavailable }, 503, {
        'Retry-After': '60',
      });
    }
    // Names and SQLSTATE only: a drizzle error message carries the query parameters, the
    // order's access token among them.
    logger?.error(errorInfo(error), 'order action failed');
    return json({ error: 'internal', message: ACTION_MESSAGES.internal }, 500);
  }
}
