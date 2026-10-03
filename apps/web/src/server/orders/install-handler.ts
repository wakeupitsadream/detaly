/**
 * POST /api/orders/<token>/install `{slotAt, requestKey}` and POST
 * /api/orders/<token>/install/cancel `{bookingId}` (docs/phase-1c-implementation.md section
 * 10.2, decision С6). The installation is the partner's service (INSTALL_PARTNER_NAME), paid
 * at the service by its own receipt: nothing here has a price.
 *
 * bookInstall re-checks the slot against the fresh load under the order row lock and
 * pg_advisory_xact_lock, so two clients never get the last lift of an hour (the second gets
 * 409 slot_taken); a repeated form with the same requestKey returns the same booking. The
 * client cancels their own booking without the phone digits, not later than 2 hours before.
 *
 * Order of checks: Origin (403) -> order token (404) -> body (400) -> order (404) -> partner
 * configured (409) -> fields (422) -> the engine. Plain forms get 303 back to /o/<token>#install
 * with a flash code, scripts get JSON. The IP limit `install` (20 per hour) is in src/proxy.ts.
 * Logs: the order number and the outcome, never the token.
 */
import type { Logger } from '@detaly/config';
import {
  bookInstall,
  cancelInstall,
  isUuid,
  loadBookingsView,
  type EngineDeps,
} from '@detaly/orders';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { readPhotoForm, UploadError } from '../uploads';
import { isOrderToken } from './access';
import { formAnswer, jsonAnswer, type FormOutcome } from './form-response';
import { installPartner } from './order-services';

/** `slotAt` (ISO with offset) and a uuid fit easily. */
export const MAX_INSTALL_BODY_BYTES = 2048;

export const INSTALL_MESSAGES = {
  forbidden: 'Запрос отклонён. Обновите страницу и попробуйте ещё раз',
  notFound: 'Заказ не найден',
  badRequest: 'Не удалось прочитать запрос',
  unavailable: 'Запись на установку для этого заказа сейчас недоступна',
  badSlot: 'Выберите время из списка',
  taken: 'Это время только что заняли — выберите другое',
  already: 'У заказа уже есть запись на установку',
  booked: 'Вы записаны — мастер подтвердит время',
  cancelled: 'Запись на установку отменена',
  internal: 'Ошибка сервера, попробуйте позже',
} as const;

const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface InstallHandlerDeps {
  engine: EngineDeps;
  appBaseUrl: string;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

type Prelude =
  | { ok: false; response: Response }
  | {
      ok: true;
      fields: Map<string, string>;
      order: { id: string; number: string; userId: string };
    };

/** Origin, token, the small urlencoded body and the order. */
async function prelude(
  request: Request,
  token: string,
  deps: InstallHandlerDeps,
): Promise<Prelude> {
  if (!isSameOrigin(request.headers, deps.appBaseUrl)) {
    return {
      ok: false,
      response: jsonAnswer({ error: 'forbidden_origin', message: INSTALL_MESSAGES.forbidden }, 403),
    };
  }
  const notFound = {
    ok: false as const,
    response: jsonAnswer({ error: 'not_found', message: INSTALL_MESSAGES.notFound }, 404),
  };
  if (!isOrderToken(token)) return notFound;
  let fields: Map<string, string>;
  try {
    ({ fields } = await readPhotoForm(request, {
      maxFiles: 0,
      maxFileBytes: 0,
      maxTotalBytes: MAX_INSTALL_BODY_BYTES,
    }));
  } catch (error) {
    if (!(error instanceof UploadError)) throw error;
    return {
      ok: false,
      response: jsonAnswer({ error: 'bad_request', message: INSTALL_MESSAGES.badRequest }, 400),
    };
  }
  const order = await deps.engine.db.query.orders.findFirst({
    where: (t, ops) => ops.eq(t.accessToken, token),
    columns: { id: true, number: true, userId: true },
  });
  if (!order) return notFound;
  return { ok: true, fields, order };
}

function internal(request: Request, deps: InstallHandlerDeps, token: string, error: unknown) {
  // Names and SQLSTATE only: driver messages carry the query parameters (the token).
  deps.logger?.error(errorInfo(error), 'order: install request failed');
  return formAnswer(request, deps.appBaseUrl, token, {
    status: 500,
    code: 'internal',
    message: INSTALL_MESSAGES.internal,
    flash: 'install_unavailable',
  });
}

export async function handleInstallRequest(
  request: Request,
  token: string,
  deps: InstallHandlerDeps,
): Promise<Response> {
  try {
    const pre = await prelude(request, token, deps);
    if (!pre.ok) return pre.response;
    const { fields, order } = pre;
    const answer = (outcome: FormOutcome) => formAnswer(request, deps.appBaseUrl, token, outcome);
    if (installPartner(deps.engine.env) === null) {
      return answer({
        status: 409,
        code: 'unavailable',
        message: INSTALL_MESSAGES.unavailable,
        flash: 'install_unavailable',
      });
    }
    const slotAt = fields.get('slotAt') ?? '';
    const requestKey = (fields.get('requestKey') ?? '').toLowerCase();
    if (!ISO_INSTANT_RE.test(slotAt) || Number.isNaN(Date.parse(slotAt)) || !isUuid(requestKey)) {
      return answer({
        status: 422,
        code: 'bad_slot',
        message: INSTALL_MESSAGES.badSlot,
        flash: 'install_bad_slot',
      });
    }
    const result = await bookInstall(deps.engine, {
      orderId: order.id,
      slotAt,
      via: 'web',
      requestKey,
      actor: { type: 'client', id: order.userId },
    });
    if (result.ok) {
      deps.logger?.info(
        { order: order.number, duplicate: result.duplicate },
        'order: install booked',
      );
      return answer({
        status: 200,
        code: 'booked',
        message: INSTALL_MESSAGES.booked,
        flash: 'install_booked',
        extra: { bookingId: result.bookingId, slot: result.slot, duplicate: result.duplicate },
      });
    }
    deps.logger?.info({ order: order.number, reason: result.reason }, 'order: install refused');
    switch (result.reason) {
      case 'slot_taken':
        return answer({
          status: 409,
          code: 'slot_taken',
          message: INSTALL_MESSAGES.taken,
          flash: 'install_taken',
        });
      case 'already_booked':
        return answer({
          status: 409,
          code: 'already_booked',
          message: INSTALL_MESSAGES.already,
          flash: 'install_already',
        });
      case 'bad_slot':
        return answer({
          status: 422,
          code: 'bad_slot',
          message: INSTALL_MESSAGES.badSlot,
          flash: 'install_bad_slot',
        });
      case 'not_allowed':
        return answer({
          status: 409,
          code: 'not_allowed',
          message: INSTALL_MESSAGES.unavailable,
          flash: 'install_unavailable',
        });
    }
  } catch (error) {
    return internal(request, deps, token, error);
  }
}

export async function handleInstallCancel(
  request: Request,
  token: string,
  deps: InstallHandlerDeps,
): Promise<Response> {
  try {
    const pre = await prelude(request, token, deps);
    if (!pre.ok) return pre.response;
    const { fields, order } = pre;
    const answer = (outcome: FormOutcome) => formAnswer(request, deps.appBaseUrl, token, outcome);
    const bookingId = (fields.get('bookingId') ?? '').toLowerCase();
    // Only a booking of this very order (cancelInstall itself checks the client).
    const bookings = isUuid(bookingId) ? await loadBookingsView(deps.engine.db, order.id) : [];
    if (!bookings.some((booking) => booking.id === bookingId)) {
      return answer({
        status: 404,
        code: 'not_found',
        message: 'Запись не найдена',
        flash: 'install_cancel_error',
      });
    }
    const result = await cancelInstall(deps.engine, {
      bookingId,
      actor: { type: 'client', id: order.userId },
    });
    if (result.ok) {
      deps.logger?.info({ order: order.number }, 'order: install cancelled by client');
      return answer({
        status: 200,
        code: 'cancelled',
        message: INSTALL_MESSAGES.cancelled,
        flash: 'install_cancelled',
      });
    }
    deps.logger?.info(
      { order: order.number, reason: result.reason },
      'order: install cancel refused',
    );
    return answer({
      status: result.reason === 'not_found' ? 404 : 409,
      code: result.reason,
      message: result.message,
      flash: result.reason === 'too_late' ? 'install_cancel_late' : 'install_cancel_error',
    });
  } catch (error) {
    return internal(request, deps, token, error);
  }
}
