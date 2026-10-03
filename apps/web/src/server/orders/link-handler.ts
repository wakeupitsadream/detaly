/**
 * POST /api/orders/<token>/link (docs/phase-1c-implementation.md section 10.1, decision С3):
 * «Статусы в Telegram» on /o/<token>. Creates a one-time link token (24 random bytes, 24 h)
 * and answers 303 to `https://t.me/<TG_CLIENT_BOT_USERNAME>?start=<link token>`. The deep link
 * carries the link token only, never the order page token; the bot asks for the phone and
 * binds the account only when it matches the order's phone. It is a subscription to statuses,
 * not a sign-in.
 *
 * Order of checks: Origin (403) -> order token (404) -> body (400) -> channel (MAX: 409) ->
 * order (404) -> bot configured (409) -> 303 (JSON: 200 with `redirectUrl`). The IP rate limit
 * `link` (20 per hour) is applied in src/proxy.ts. Logs: the order number only.
 */
import type { Logger } from '@detaly/config';
import { createLinkToken, type EngineDeps } from '@detaly/orders';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { readPhotoForm, UploadError } from '../uploads';
import { isOrderToken } from './access';
import { formAnswer, jsonAnswer, seeOther, wantsJson, type FormOutcome } from './form-response';
import { clientBotUsername } from './order-services';

/** The form carries `channel` only. */
export const MAX_LINK_BODY_BYTES = 1024;

export const LINK_MESSAGES = {
  forbidden: 'Запрос отклонён. Обновите страницу и попробуйте ещё раз',
  notFound: 'Заказ не найден',
  badRequest: 'Не удалось прочитать запрос',
  unavailable: 'Подключение Telegram пока недоступно',
  maxSoon: 'Статусы в MAX появятся после запуска бота MAX',
  internal: 'Не получилось создать ссылку, попробуйте через минуту',
} as const;

export interface LinkHandlerDeps {
  engine: Pick<EngineDeps, 'db' | 'env' | 'now'>;
  appBaseUrl: string;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** t.me deep link of the client bot. */
export function telegramDeepLink(username: string, linkToken: string): string {
  return `https://t.me/${username}?start=${encodeURIComponent(linkToken)}`;
}

export async function handleLinkRequest(
  request: Request,
  token: string,
  deps: LinkHandlerDeps,
): Promise<Response> {
  if (!isSameOrigin(request.headers, deps.appBaseUrl)) {
    return jsonAnswer({ error: 'forbidden_origin', message: LINK_MESSAGES.forbidden }, 403);
  }
  if (!isOrderToken(token)) {
    return jsonAnswer({ error: 'not_found', message: LINK_MESSAGES.notFound }, 404);
  }
  let channel = 'telegram';
  if (request.body !== null && !wantsJson(request)) {
    try {
      const form = await readPhotoForm(request, {
        maxFiles: 0,
        maxFileBytes: 0,
        maxTotalBytes: MAX_LINK_BODY_BYTES,
      });
      channel = form.fields.get('channel') || 'telegram';
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      return jsonAnswer({ error: 'bad_request', message: LINK_MESSAGES.badRequest }, 400);
    }
  }
  const unavailable = (message: string): FormOutcome => ({
    status: 409,
    code: 'unavailable',
    message,
    flash: 'link_unavailable',
  });
  const { engine, logger } = deps;
  try {
    const order = await engine.db.query.orders.findFirst({
      where: (t, ops) => ops.eq(t.accessToken, token),
      columns: { id: true, number: true, userId: true, status: true },
    });
    if (!order) return jsonAnswer({ error: 'not_found', message: LINK_MESSAGES.notFound }, 404);
    if (channel !== 'telegram') {
      return formAnswer(request, deps.appBaseUrl, token, unavailable(LINK_MESSAGES.maxSoon));
    }
    const username = clientBotUsername(engine.env);
    if (username === null || order.status === 'cancelled' || order.status === 'refunded') {
      return formAnswer(request, deps.appBaseUrl, token, unavailable(LINK_MESSAGES.unavailable));
    }
    const link = await createLinkToken(engine.db, {
      userId: order.userId,
      orderId: order.id,
      channel: 'telegram',
      now: engine.now?.() ?? new Date(),
    });
    logger?.info({ order: order.number, channel: 'telegram' }, 'order: messenger link created');
    const location = telegramDeepLink(username, link.token);
    if (wantsJson(request)) return jsonAnswer({ redirectUrl: location }, 200);
    return seeOther(location);
  } catch (error) {
    // Names and SQLSTATE only: driver messages carry the query parameters (the token).
    logger?.error(errorInfo(error), 'order: messenger link failed');
    return formAnswer(request, deps.appBaseUrl, token, {
      status: 500,
      code: 'internal',
      message: LINK_MESSAGES.internal,
      flash: 'link_error',
    });
  }
}
