/**
 * HTTP side of the cart API (docs/phase-1a-implementation.md section 5.1, decisions Д19–Д21):
 *
 * - urlencoded or multipart forms (the cart works without JavaScript): success is
 *   `303 → /cart` (`/cart?added=1` after an add), an error is `303 → /cart?error=<code>`;
 * - JSON: `200 {count, totalKop}` or `{error, message}` with the status of the code.
 *
 * Every request passes isSameOrigin before its body is read (403). The cart cookie is set
 * only here, from cart-store's token and options. Rate limits are applied in src/proxy.ts.
 */
import type { Env } from '@detaly/config';
import { cartCookieOptions, CART_COOKIE, readCartToken } from '../cart-store';
import { isSameOrigin } from '../request-guards';
import type { CartService, CartSnapshot } from './cart-service';
import { CART_ERROR_MESSAGES, CartRequestError, isCartRequestError } from './errors';

export interface CartHandlerDeps {
  service: CartService;
  env: Pick<Env, 'APP_BASE_URL' | 'CART_TTL_DAYS'>;
  /** Unexpected failures (500); never receives client data. */
  onError?: (error: unknown) => void;
}

type Mode = 'form' | 'json';

const NO_STORE = 'no-store';

function requestMode(request: Request): Mode {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  return type.startsWith('application/x-www-form-urlencoded') ||
    type.startsWith('multipart/form-data')
    ? 'form'
    : 'json';
}

/** Cookie header values by name (first wins), for readCartToken. */
export function requestCookies(request: Request): {
  get(name: string): { value: string } | undefined;
} {
  const values = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '' || values.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      values.set(name, decodeURIComponent(value));
    } catch {
      values.set(name, value);
    }
  }
  return { get: (name) => (values.has(name) ? { value: values.get(name) ?? '' } : undefined) };
}

/** `Set-Cookie` value for the cart token (HttpOnly, SameSite=Lax, Secure on https). */
export function cartSetCookie(
  token: string,
  env: Pick<Env, 'APP_BASE_URL' | 'CART_TTL_DAYS'>,
): string {
  const options = cartCookieOptions(env);
  const parts = [
    `${CART_COOKIE}=${token}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Body fields of a form or a JSON object; null when the body cannot be parsed. */
async function readBody(request: Request, mode: Mode): Promise<Record<string, unknown> | null> {
  try {
    if (mode === 'form') {
      const form = await request.formData();
      const out: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string' && !(key in out)) out[key] = value;
      }
      return out;
    }
    const text = await request.text();
    if (text.trim() === '') return {};
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': NO_STORE });
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return new Response(null, { status: 303, headers });
}

function success(mode: Mode, result: CartSnapshot, location: string, setCookie?: string) {
  if (mode === 'form') return redirect(location, setCookie);
  const headers = new Headers({ 'Cache-Control': NO_STORE });
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return Response.json({ count: result.count, totalKop: result.totalKop }, { headers });
}

function failure(mode: Mode, error: CartRequestError): Response {
  if (mode === 'form' && error.code !== 'forbidden_origin') {
    return redirect(`/cart?error=${error.code}`);
  }
  const headers = new Headers({ 'Cache-Control': NO_STORE });
  if (error.retryAfterSec !== null) headers.set('Retry-After', String(error.retryAfterSec));
  if (mode === 'form') {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    return new Response(error.message, { status: error.status, headers });
  }
  return Response.json(
    { error: error.code, message: error.message },
    { status: error.status, headers },
  );
}

async function run(
  request: Request,
  deps: CartHandlerDeps,
  action: (body: Record<string, unknown>, token: string | null) => Promise<Response>,
): Promise<Response> {
  const mode = requestMode(request);
  try {
    if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
      throw new CartRequestError('forbidden_origin');
    }
    const body = await readBody(request, mode);
    if (body === null) throw new CartRequestError('invalid');
    return await action(body, readCartToken(requestCookies(request)));
  } catch (error) {
    if (isCartRequestError(error)) return failure(mode, error);
    deps.onError?.(error);
    return failure(mode, new CartRequestError('internal', CART_ERROR_MESSAGES.internal));
  }
}

/** POST /api/cart/items: `q`, `offerId`, optional `qty`. */
export function handleAddItem(request: Request, deps: CartHandlerDeps): Promise<Response> {
  const mode = requestMode(request);
  return run(request, deps, async (body, token) => {
    const result = await deps.service.addItem({
      token,
      q: body.q,
      offerId: body.offerId,
      qty: body.qty,
    });
    return success(mode, result, '/cart?added=1', cartSetCookie(result.token, deps.env));
  });
}

/**
 * /api/cart/items/<id>: PATCH `qty`, DELETE, or POST with `_method=patch|delete` (forms
 * cannot send other methods).
 */
export function handleLineRequest(
  request: Request,
  lineId: string,
  deps: CartHandlerDeps,
): Promise<Response> {
  const mode = requestMode(request);
  const method = request.method.toUpperCase();
  return run(request, deps, async (body, token) => {
    let action = method;
    if (method === 'POST') {
      const override = typeof body._method === 'string' ? body._method.trim().toUpperCase() : '';
      if (override !== 'PATCH' && override !== 'DELETE') throw new CartRequestError('invalid');
      action = override;
    }
    const result =
      action === 'DELETE'
        ? await deps.service.removeItem({ token, lineId })
        : action === 'PATCH'
          ? await deps.service.updateItem({ token, lineId, qty: body.qty })
          : null;
    if (result === null) throw new CartRequestError('invalid');
    return success(mode, result, '/cart');
  });
}
