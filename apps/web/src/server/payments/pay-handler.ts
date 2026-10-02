/**
 * POST /api/orders/<token>/pay: «Оплатить N ₽» on /o/<token> (docs/phase-1b-implementation.md
 * 14.1, decisions Б5–Б7). A plain HTML form (303 redirects) or JSON (`{ redirectUrl }`).
 *
 * Order: Origin (403) -> token (404) -> payments enabled (Б6) -> order awaiting_payment ->
 * preparePayment under the order lock:
 * - `reuse`: a live pending payment with its link -> 303 to it (a second click never creates a
 *   second payment);
 * - `create`: POST /payments with the row's Idempotence-Key (timeout 15 s) -> recordPaymentCreated
 *   -> 303 to confirmation_url. A provider error -> 303 /o/<token>?pay=error; after a network
 *   error, a timeout or a 5xx the payments row stays pending without a provider id, so the next
 *   click (or reconciliation) repeats the same key and body and YooKassa answers with the same
 *   payment. A final rejection (HTTP 4xx, or a request refused before sending) proves no payment
 *   exists: the row is closed (recordPaymentRejected, owner alerted) and the next click takes a
 *   new row with a new key instead of repeating a refused body.
 * return_url = APP_BASE_URL/o/<token>?paid=1 («Проверяем оплату…»); YOOKASSA_RETURN_URL is not
 * used: the return address must carry the order token. VERIFY: Ю11 — YooKassa keeps the query
 * string of return_url as given.
 *
 * Logs carry the order number, row ids and error codes: never the token, the phone or the
 * confirmation link.
 */
import type { Logger } from '@detaly/config';
import {
  preparePayment,
  recordPaymentCreated,
  recordPaymentRejected,
  type EngineDeps,
} from '@detaly/orders';
import { PaymentProviderError, PaymentRequestError, type PaymentProvider } from '@detaly/payments';
import { errorInfo } from '../errors';
import { isOrderToken } from '../orders/access';
import { isSameOrigin } from '../request-guards';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const PAY_MESSAGES = {
  forbidden: 'Запрос отклонён. Обновите страницу и попробуйте ещё раз',
  notFound: 'Заказ не найден',
  disabled: 'Оплата онлайн пока не подключена',
  notPayable: 'Этот заказ сейчас не ждёт оплаты — обновите страницу',
  failed: 'Не удалось создать платёж, попробуйте ещё раз',
  internal: 'Ошибка сервера, попробуйте позже',
} as const;

/** ?pay=<code> on /o/<token> after a failed attempt. */
export type PayErrorCode = 'error' | 'unavailable';

export interface PayHandlerDeps {
  engine: EngineDeps;
  /** null when payments are disabled (decision Б6). */
  payments: Pick<PaymentProvider, 'createPayment'> | null;
  appBaseUrl: string;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

function baseUrl(appBaseUrl: string): string {
  return appBaseUrl.replace(/\/+$/u, '');
}

/** /o/<token> with optional query, absolute (Location of a 303). */
export function orderPageUrl(appBaseUrl: string, token: string, query = ''): string {
  return `${baseUrl(appBaseUrl)}/o/${token}${query}`;
}

/** return_url of an online payment: the order page in «Проверяем оплату…» mode. */
export function payReturnUrl(appBaseUrl: string, token: string): string {
  return orderPageUrl(appBaseUrl, token, '?paid=1');
}

/** JSON callers get JSON; a form navigation (Accept text/html) gets 303 redirects. */
function wantsJson(request: Request): boolean {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('application/json')) return true;
  const accept = (request.headers.get('accept') ?? '').toLowerCase();
  return accept.includes('application/json') && !accept.includes('text/html');
}

/** Only an http(s) URL is followed; anything else from the provider is treated as missing. */
function safeLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string') return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

interface Outcome {
  /** Where a form navigation goes. */
  location: string;
  /** JSON answer. */
  status: number;
  body: Record<string, unknown>;
}

function redirectOutcome(location: string): Outcome {
  return { location, status: 200, body: { redirectUrl: location } };
}

function respond(request: Request, outcome: Outcome): Response {
  if (wantsJson(request)) {
    return Response.json(outcome.body, { status: outcome.status, headers: NO_STORE });
  }
  return new Response(null, { status: 303, headers: { ...NO_STORE, Location: outcome.location } });
}

function failure(
  appBaseUrl: string,
  token: string,
  code: PayErrorCode,
  status: number,
  error: string,
  message: string,
): Outcome {
  return {
    location: orderPageUrl(appBaseUrl, token, `?pay=${code}`),
    status,
    body: { error, message },
  };
}

function providerErrorInfo(error: unknown): Record<string, unknown> {
  if (
    error instanceof PaymentProviderError ||
    (error as Error | null)?.name === 'PaymentProviderError'
  ) {
    const details = (error as PaymentProviderError).details;
    return {
      err: 'PaymentProviderError',
      status: details?.status ?? null,
      code: details?.code ?? null,
      retryable: details?.retryable ?? null,
    };
  }
  return errorInfo(error);
}

/**
 * The error proves the provider did not create the payment: a final HTTP 4xx answer, or a
 * request refused locally before sending. Returns the code for payments.cancellation_reason;
 * null for errors after which the payment may exist (network, timeout, 5xx, 429, unreadable).
 */
export function paymentRejection(error: unknown): string | null {
  if (
    error instanceof PaymentRequestError ||
    (error as Error | null)?.name === 'PaymentRequestError'
  ) {
    return 'PaymentRequestError';
  }
  if (
    error instanceof PaymentProviderError ||
    (error as Error | null)?.name === 'PaymentProviderError'
  ) {
    const details = (error as PaymentProviderError).details;
    const status = details?.status ?? null;
    if (details?.retryable === false && status !== null && status >= 400 && status < 500) {
      return `${details.code ?? 'error'} (HTTP ${status})`;
    }
  }
  return null;
}

async function pay(token: string, deps: PayHandlerDeps): Promise<Outcome> {
  const { engine, appBaseUrl, logger } = deps;
  if (deps.payments === null) {
    return failure(
      appBaseUrl,
      token,
      'unavailable',
      503,
      'payments_disabled',
      PAY_MESSAGES.disabled,
    );
  }
  const order = await engine.db.query.orders.findFirst({
    where: (t, ops) => ops.eq(t.accessToken, token),
    columns: { id: true, number: true, status: true, paymentScheme: true },
  });
  if (!order) {
    return {
      location: orderPageUrl(appBaseUrl, token),
      status: 404,
      body: { error: 'not_found', message: PAY_MESSAGES.notFound },
    };
  }
  const notPayable: Outcome = {
    location: orderPageUrl(appBaseUrl, token),
    status: 409,
    body: { error: 'not_payable', message: PAY_MESSAGES.notPayable },
  };
  if (order.status !== 'awaiting_payment' || order.paymentScheme !== 'prepay') return notPayable;

  const prepared = await preparePayment(engine, {
    orderId: order.id,
    kind: 'prepayment',
    confirmation: 'redirect',
    returnUrl: payReturnUrl(appBaseUrl, token),
  });
  if (prepared.kind === 'unavailable') {
    if (prepared.reason === 'wrong_status' || prepared.reason === 'already_paid') {
      return notPayable;
    }
    if (prepared.reason === 'payments_disabled') {
      return failure(
        appBaseUrl,
        token,
        'unavailable',
        503,
        'payments_disabled',
        PAY_MESSAGES.disabled,
      );
    }
    if (prepared.reason === 'not_found') {
      return {
        location: orderPageUrl(appBaseUrl, token),
        status: 404,
        body: { error: 'not_found', message: PAY_MESSAGES.notFound },
      };
    }
    // A receipt precondition (no phone for customer.phone, receipt lines): never pay without
    // a receipt (54-FZ); the owner sees it in the log.
    logger?.warn({ order: order.number, reason: prepared.reason }, 'pay: payment unavailable');
    return failure(appBaseUrl, token, 'error', 409, 'payment_unavailable', PAY_MESSAGES.failed);
  }
  if (prepared.kind === 'reuse') {
    const link = safeLink(prepared.confirmationUrl);
    if (link !== null) {
      logger?.info({ order: order.number }, 'pay: existing payment reused');
      return redirectOutcome(link);
    }
    return failure(appBaseUrl, token, 'error', 502, 'payment_failed', PAY_MESSAGES.failed);
  }

  let created;
  try {
    created = await deps.payments.createPayment(prepared.request);
  } catch (error) {
    logger?.warn(
      { order: order.number, paymentId: prepared.paymentRowId, ...providerErrorInfo(error) },
      'pay: payment creation failed',
    );
    const rejection = paymentRejection(error);
    if (rejection !== null) {
      try {
        await recordPaymentRejected(engine, prepared.paymentRowId, rejection);
      } catch (recordError) {
        // Reconciliation repeats the POST, gets the same refusal and closes the row then.
        logger?.error(
          { order: order.number, paymentId: prepared.paymentRowId, ...errorInfo(recordError) },
          'pay: recording the rejection failed',
        );
      }
    }
    return failure(appBaseUrl, token, 'error', 502, 'payment_failed', PAY_MESSAGES.failed);
  }
  try {
    await recordPaymentCreated(engine, prepared.paymentRowId, created);
  } catch (error) {
    // The payment exists at the provider: the client may still pay it; reconciliation repeats
    // POST /payments with the same key and records it.
    logger?.error(
      { order: order.number, paymentId: prepared.paymentRowId, ...errorInfo(error) },
      'pay: recording the payment failed',
    );
  }
  logger?.info(
    { order: order.number, paymentId: prepared.paymentRowId, status: created.status },
    'pay: payment created',
  );
  const link = safeLink(created.confirmationUrl);
  if (link !== null && (created.status === 'pending' || created.status === 'waiting_for_capture')) {
    return redirectOutcome(link);
  }
  // Already final (paid or canceled at once): the order page tells which.
  return redirectOutcome(payReturnUrl(appBaseUrl, token));
}

export async function handlePayRequest(
  request: Request,
  token: string,
  deps: PayHandlerDeps,
): Promise<Response> {
  if (!isSameOrigin(request.headers, deps.appBaseUrl)) {
    return Response.json(
      { error: 'forbidden_origin', message: PAY_MESSAGES.forbidden },
      { status: 403, headers: NO_STORE },
    );
  }
  if (!isOrderToken(token)) {
    return Response.json(
      { error: 'not_found', message: PAY_MESSAGES.notFound },
      { status: 404, headers: NO_STORE },
    );
  }
  try {
    return respond(request, await pay(token, deps));
  } catch (error) {
    // Names and SQLSTATE only: a drizzle error message carries the query parameters, the
    // order's access token among them.
    deps.logger?.error(errorInfo(error), 'pay failed');
    return respond(
      request,
      failure(deps.appBaseUrl, token, 'error', 500, 'internal', PAY_MESSAGES.internal),
    );
  }
}
