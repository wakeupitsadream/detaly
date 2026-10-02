/** HTTP adapter of the checkout service: Request (JSON body, `cart` cookie) -> Response. */
import { readCartToken } from '../cart-store';
import type { CheckoutService } from './checkout-service';

/** Largest accepted body: the form is a dozen short fields. */
export const MAX_CHECKOUT_BODY_BYTES = 16 * 1024;

/** Cookie lookup over a raw `Cookie` header (first occurrence wins, as browsers send it). */
export function cookieSource(header: string | null): {
  get(name: string): { value: string } | undefined;
} {
  const values = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!values.has(name)) values.set(name, part.slice(eq + 1).trim());
  }
  return {
    get: (name) => {
      const value = values.get(name);
      return value === undefined ? undefined : { value };
    },
  };
}

/**
 * JSON body, or undefined when it is missing, too large or not JSON. The body is read as a
 * stream and abandoned past MAX_CHECKOUT_BODY_BYTES: nothing in front of web (Caddy, Next route
 * handlers) caps request bodies, so `request.text()` would buffer whatever a client sends.
 */
export async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_CHECKOUT_BODY_BYTES || request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CHECKOUT_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    if (size === 0) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export async function handleCheckoutRequest(
  request: Request,
  service: CheckoutService,
): Promise<Response> {
  const body = await readJson(request);
  const result = await service.checkout({
    headers: request.headers,
    body,
    cartToken: readCartToken(cookieSource(request.headers.get('cookie'))),
  });
  return Response.json(result.body, { status: result.status, headers: result.headers });
}
