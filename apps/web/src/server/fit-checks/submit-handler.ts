/**
 * POST /api/fit-checks (step 4, docs/fit-check.md): «Отправить мастеру» of the fit check form
 * in the cart — the VIN, an optional comment and the ticked lines of the caller's own cart.
 *
 * Order of checks: Origin (403) -> the checkout gate (403: checks open together with online
 * orders; the body is not even read, so no VIN is stored) -> the bounded body (400/413) ->
 * honeypot (400) -> fields (422, every error at once) -> the cart of the `cart` cookie (404) ->
 * the per-cart limit, 10 requests a day (429; the per-ip limit of 20 a day is counted in
 * src/proxy.ts) -> createFitCheckRequest: every line id must be a line of that cart (422 when
 * one is not — ids from a form are never trusted), lines already waiting are skipped (409 when
 * all are) -> the outbox nudge -> 303 back to the cart (or JSON for the sheet with JavaScript).
 *
 * A refused form post without JavaScript returns to `/cart?fit_error=<code>&check=<line>`:
 * codes, never values (the VIN never goes into a URL). Logs carry the request id and counts:
 * never the VIN, the comment or the cart token.
 */
import type { Env } from '@detaly/config';
import type { Database } from '@detaly/db';
import { createFitCheckRequest, type CreateFitCheckRefusal } from '@detaly/vin';
import { readBoundedText } from '../body';
import { findActiveCart, readCartToken } from '../cart-store';
import { requestCookies } from '../cart/http';
import { gatePhone, type CheckoutGate } from '../checkout-gate';
import { errorInfo } from '../errors';
import type { RateLimitDecision } from '../rate-limit';
import { HONEYPOT_FIELD, isHoneypotTripped, isSameOrigin } from '../request-guards';
import { jsonResponse, messagePage, seeOther, wantsJson } from '../vin/http';
import { fitClosedText } from './texts';
import {
  FIT_FORM_FIELDS,
  FIT_FORM_MESSAGES,
  lineIdOf,
  parseFitForm,
  type FitFormErrorCode,
  type FitFormFields,
} from './form';

export interface FitSubmitLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface FitSubmitDeps {
  db: Database;
  env: Pick<Env, 'APP_BASE_URL' | 'PICKUP_PHONE' | 'SELLER_REQUISITES_PHONE'>;
  /** getCheckoutGate bound to env and db: checks open with online orders (like /vin). */
  gate: () => Promise<CheckoutGate>;
  /**
   * Counts one request of this cart (rate limit `fit_check_cart`, 10 a day); null when the
   * limiter is unavailable (fail open, as the proxy does).
   */
  limitCart: (cartId: string) => Promise<RateLimitDecision | null>;
  logger: FitSubmitLogger;
  now?: () => Date;
  /** Wakes the outbox dispatcher after the commit (decision Б1); best effort. */
  nudge?: () => void;
}

/** The form has the VIN, a comment of 200 characters and up to 40 ids: 16 KB is plenty. */
export const MAX_FIT_BODY_BYTES = 16 * 1024;

export const FIT_SUBMIT_MESSAGES = {
  forbiddenOrigin: 'Запрос отклонён: откройте корзину на сайте и отправьте проверку ещё раз',
  rejected: 'Запрос отклонён',
  tooLarge: 'Форма слишком большая',
} as const;

/** The closed gate: checks open together with online orders; until then, the phone. */
export function fitClosedMessage(
  env: Pick<Env, 'PICKUP_PHONE' | 'SELLER_REQUISITES_PHONE'>,
): string {
  return fitClosedText(gatePhone(env));
}

const REFUSALS: Record<CreateFitCheckRefusal, { status: number; code: FitFormErrorCode }> = {
  vin: { status: 422, code: 'vin' },
  comment: { status: 422, code: 'comment' },
  no_lines: { status: 422, code: 'lines' },
  foreign_lines: { status: 422, code: 'lines_foreign' },
  pending: { status: 409, code: 'pending' },
};

type Mode = 'form' | 'json';

function modeOf(request: Request): Mode | null {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (type.startsWith('application/x-www-form-urlencoded')) return 'form';
  if (type.startsWith('application/json')) return 'json';
  return null;
}

/** The fields of an urlencoded body or a JSON object (`lines` as an array). */
function fieldsOf(mode: Mode, text: string): FitFormFields | null {
  if (mode === 'form') {
    const form = new URLSearchParams(text);
    return {
      get: (name) => form.get(name) ?? undefined,
      getAll: (name) => form.getAll(name),
    };
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  const scalar = (value: unknown) =>
    typeof value === 'string' ? value : typeof value === 'boolean' ? String(value) : undefined;
  return {
    get: (name) => scalar(body[name]),
    getAll: (name) => {
      const value = body[name];
      if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item : ''));
      return typeof value === 'string' ? [value] : [];
    },
  };
}

export async function handleFitSubmit(request: Request, deps: FitSubmitDeps): Promise<Response> {
  const json = wantsJson(request) || modeOf(request) === 'json';
  const now = deps.now ?? (() => new Date());
  // The action URL carries the line the form was opened from (`?line=`): not personal data.
  const queryLine = lineIdOf(new URL(request.url, deps.env.APP_BASE_URL).searchParams.get('line'));
  const backTo = (line: string | null) => (line ? `/cart?check=${line}#fit-${line}` : '/cart');

  /** A refused form: JSON for the sheet, otherwise back to the cart with the code. */
  const refuse = (
    status: number,
    code: FitFormErrorCode,
    line: string | null,
    message: string = FIT_FORM_MESSAGES[code],
    headers: Record<string, string> = {},
  ): Response => {
    if (json) {
      return Response.json(
        { error: code, message },
        { status, headers: { 'Cache-Control': 'no-store', ...headers } },
      );
    }
    if (status === 429) {
      const page = messagePage(429, 'Слишком много проверок', message, {
        href: backTo(line),
        label: 'Вернуться в корзину',
      });
      for (const [name, value] of Object.entries(headers)) page.headers.set(name, value);
      return page;
    }
    const target = line
      ? `/cart?fit_error=${code}&check=${line}#fit-${line}`
      : `/cart?fit_error=${code}`;
    return seeOther(target);
  };

  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return json
      ? jsonResponse(403, {
          error: 'forbidden_origin',
          message: FIT_SUBMIT_MESSAGES.forbiddenOrigin,
        })
      : messagePage(403, 'Проверка не отправлена', FIT_SUBMIT_MESSAGES.forbiddenOrigin, {
          href: '/cart',
          label: 'Вернуться в корзину',
        });
  }

  // The gate first: while it is closed the body is not read at all (no VIN is stored).
  const gate = await deps.gate().catch((error: unknown) => {
    deps.logger.warn(errorInfo(error), 'fit check: checkout gate failed');
    return null;
  });
  if (gate === null || !gate.open) {
    return refuse(403, 'closed', queryLine, fitClosedMessage(deps.env));
  }

  const mode = modeOf(request);
  if (mode === null) return refuse(400, 'form', queryLine);
  const body = await readBoundedText(request, MAX_FIT_BODY_BYTES);
  if (!body.ok) {
    return json
      ? jsonResponse(413, { error: 'too_large', message: FIT_SUBMIT_MESSAGES.tooLarge })
      : messagePage(413, 'Проверка не отправлена', FIT_SUBMIT_MESSAGES.tooLarge, {
          href: '/cart',
          label: 'Вернуться в корзину',
        });
  }
  const fields = fieldsOf(mode, body.text);
  if (fields === null) return refuse(400, 'form', queryLine);
  const line = lineIdOf(fields.get(FIT_FORM_FIELDS.line)) ?? queryLine;

  if (isHoneypotTripped(fields.get(HONEYPOT_FIELD))) {
    deps.logger.warn({}, 'fit check honeypot');
    return json
      ? jsonResponse(400, { error: 'rejected', message: FIT_SUBMIT_MESSAGES.rejected })
      : messagePage(400, 'Проверка не отправлена', FIT_SUBMIT_MESSAGES.rejected, {
          href: '/cart',
          label: 'Вернуться в корзину',
        });
  }

  const parsed = parseFitForm(fields);
  if (!parsed.ok) {
    const code = parsed.codes[0] ?? 'form';
    if (json) {
      return Response.json(
        {
          error: code,
          message: FIT_FORM_MESSAGES[code],
          codes: parsed.codes,
        },
        { status: code === 'form' ? 400 : 422, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return refuse(422, code, line);
  }
  const { input } = parsed;

  try {
    const token = readCartToken(requestCookies(request));
    const cart = token === null ? null : await findActiveCart(deps.db, token);
    if (cart === null || cart.lines.length === 0) return refuse(404, 'cart', null);

    const lineIds = input.all ? cart.lines.map((l) => l.id) : input.lineIds;
    const limit = await deps.limitCart(cart.cart.id);
    if (limit !== null && !limit.allowed) {
      deps.logger.info({ window: limit.window }, 'fit check: cart limit');
      return refuse(429, 'rate_limited', line, FIT_FORM_MESSAGES.rate_limited, {
        'Retry-After': String(limit.retryAfterSec),
      });
    }

    const created = await createFitCheckRequest(deps.db, {
      cartId: cart.cart.id,
      lineIds,
      vin: input.vin,
      comment: input.comment,
      now: now(),
    });
    if (!created.ok) {
      const refusal = REFUSALS[created.reason];
      deps.logger.info({ reason: created.reason }, 'fit check refused');
      return refuse(refusal.status, refusal.code, line);
    }
    try {
      deps.nudge?.();
    } catch {
      // best effort: the dispatcher polls anyway
    }
    deps.logger.info(
      { fitRequest: created.requestId, lines: created.lines, skipped: created.skipped },
      'fit check request created',
    );
    if (json) {
      return jsonResponse(200, { ok: true, lines: created.lines, skipped: created.skipped });
    }
    return seeOther(line ? `/cart?fit=sent#fit-${line}` : '/cart?fit=sent');
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the parameters (the VIN, the token).
    deps.logger.error(errorInfo(error), 'fit check failed');
    return refuse(500, 'internal', line);
  }
}
