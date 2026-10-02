/**
 * POST /api/orders/<token>/cancel with JSON `{ last4 }` (docs/phase-1a-implementation.md 7.2).
 * Order of checks: Origin (403) -> token (404) -> body (400/422) -> attempt counter (429, 503
 * when Redis is down) -> row lock, digits (422 wrong_digits), state machine (409) -> 200.
 * The IP rate limit (5 per hour) is applied by src/proxy.ts before this handler runs.
 * Logs carry the order number only: no phone, no digits, no IP.
 */
import type { Logger } from '@detaly/config';
import { isNamedError } from '../errors';
import { isSameOrigin } from '../request-guards';
import { isOrderToken } from './access';
import {
  CancelUnavailableError,
  cancelOrderByToken,
  isLast4,
  type CancelDeps,
  type CancelResult,
} from './cancel';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const CANCEL_MESSAGES = {
  forbidden: 'Запрос отклонён. Обновите страницу и попробуйте ещё раз',
  notFound: 'Заказ не найден',
  badRequest: 'Не удалось прочитать запрос',
  validation: 'Введите последние 4 цифры телефона',
  wrongDigits: 'Цифры не совпадают с номером телефона из заказа',
  tooMany: 'Слишком много неверных попыток. Попробуйте позже или позвоните нам',
  notCancellable: 'Этот заказ уже нельзя отменить на сайте — позвоните нам',
  unavailable: 'Сейчас не получается отменить заказ, попробуйте через минуту',
  internal: 'Ошибка сервера, попробуйте позже',
} as const;

export interface CancelHandlerDeps extends CancelDeps {
  appBaseUrl: string;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

function json(body: Record<string, unknown>, status: number, extra?: Record<string, string>) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

async function readLast4(request: Request): Promise<{ ok: true; last4: unknown } | { ok: false }> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/json')) return { ok: false };
  try {
    const body: unknown = await request.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
    return { ok: true, last4: (body as Record<string, unknown>).last4 };
  } catch {
    return { ok: false };
  }
}

function respond(result: CancelResult, logger: CancelHandlerDeps['logger']): Response {
  switch (result.kind) {
    case 'not_found':
      return json({ error: 'not_found', message: CANCEL_MESSAGES.notFound }, 404);
    case 'too_many_attempts':
      return json({ error: 'too_many_attempts', message: CANCEL_MESSAGES.tooMany }, 429, {
        'Retry-After': String(result.retryAfterSec),
      });
    case 'wrong_digits':
      return json(
        {
          error: 'wrong_digits',
          message: CANCEL_MESSAGES.wrongDigits,
          attemptsLeft: result.attemptsLeft,
        },
        422,
      );
    case 'not_cancellable':
      return json({ error: 'not_cancellable', message: CANCEL_MESSAGES.notCancellable }, 409);
    case 'cancelled':
      logger?.info({ order: result.number, from: result.from }, 'order cancelled by client');
      return json({ status: 'cancelled' }, 200);
  }
}

export async function handleCancelRequest(
  request: Request,
  token: string,
  deps: CancelHandlerDeps,
): Promise<Response> {
  if (!isSameOrigin(request.headers, deps.appBaseUrl)) {
    return json({ error: 'forbidden_origin', message: CANCEL_MESSAGES.forbidden }, 403);
  }
  if (!isOrderToken(token)) {
    return json({ error: 'not_found', message: CANCEL_MESSAGES.notFound }, 404);
  }
  const body = await readLast4(request);
  if (!body.ok) return json({ error: 'bad_request', message: CANCEL_MESSAGES.badRequest }, 400);
  if (!isLast4(body.last4)) {
    return json({ error: 'validation', message: CANCEL_MESSAGES.validation }, 422);
  }
  try {
    const result = await cancelOrderByToken(deps, { token, last4: body.last4 });
    if (result.kind === 'wrong_digits' || result.kind === 'too_many_attempts') {
      deps.logger?.warn({ result: result.kind }, 'order cancel: wrong digits');
    }
    return respond(result, deps.logger);
  } catch (error) {
    if (isNamedError(error, CancelUnavailableError, 'CancelUnavailableError')) {
      deps.logger?.warn({ err: error.message }, 'order cancel: attempt counter unavailable');
      return json({ error: 'unavailable', message: CANCEL_MESSAGES.unavailable }, 503, {
        'Retry-After': '60',
      });
    }
    // Name and message only: a driver error object may carry query parameters (the token).
    const err = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    deps.logger?.error({ err }, 'order cancel failed');
    return json({ error: 'internal', message: CANCEL_MESSAGES.internal }, 500);
  }
}
