/**
 * Answers of the phase 1C order forms (link, install, claims): a plain HTML form gets a 303 —
 * to the bot, or back to /o/<token> with a flash code — and a script asking for JSON gets the
 * status and a Russian message, the same convention as POST /api/orders/<token>/pay.
 * Every answer is `Cache-Control: no-store`; a Location to the order page carries the order
 * token, so it is never logged (the Caddy log filter drops Location headers as well).
 */
import { orderPageUrl } from '../payments/pay-handler';
import { flashQuery, type FlashCode } from './flash';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** A script (fetch with Accept: application/json, or a JSON body) wants JSON. */
export function wantsJson(request: Request): boolean {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('application/json')) return true;
  const accept = (request.headers.get('accept') ?? '').toLowerCase();
  return accept.includes('application/json') && !accept.includes('text/html');
}

export function jsonAnswer(
  body: Record<string, unknown>,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

export function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE, Location: location, 'Referrer-Policy': 'no-referrer' },
  });
}

export interface FormOutcome {
  status: number;
  /** Machine code of the JSON answer ('ok', 'slot_taken', …). */
  code: string;
  message: string;
  /** Flash of the redirect back to the order page. */
  flash: FlashCode;
  /** Extra JSON fields (ids, attempts left). */
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** JSON or 303 back to the order page, by what the request asked for. */
export function formAnswer(
  request: Request,
  appBaseUrl: string,
  token: string,
  outcome: FormOutcome,
): Response {
  if (wantsJson(request)) {
    return jsonAnswer(
      {
        ...(outcome.status >= 400 ? { error: outcome.code } : { status: outcome.code }),
        message: outcome.message,
        ...outcome.extra,
      },
      outcome.status,
      outcome.headers,
    );
  }
  return seeOther(orderPageUrl(appBaseUrl, token, flashQuery(outcome.flash)));
}
