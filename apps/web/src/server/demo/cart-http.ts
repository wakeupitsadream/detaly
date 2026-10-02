/**
 * /api/cart/** in DEMO_MODE: the live handlers of server/cart/http.ts (origin check, bounded
 * body, forms and JSON, error codes, redirects) run unchanged over a DemoCartService whose jar
 * is this request's `demo_cart` cookie. The live `cart` token cookie the handler would set is
 * dropped from the answer, and the new `demo_cart` value is set instead when the cart changed.
 */
import type { Env } from '@detaly/config';
import { CART_COOKIE } from '../cart-store';
import type { CartHandlerDeps } from '../cart/http';
import { requestCookies } from '../cart/http';
import type { CartService } from '../cart/cart-service';
import {
  DEMO_CART_COOKIE,
  decodeDemoCart,
  demoCartSetCookie,
  encodeDemoCart,
  type DemoCartLine,
} from './cart-cookie';
import type { DemoCartJar } from './cart-service';

export interface DemoCartRequestDeps {
  env: Pick<Env, 'APP_BASE_URL' | 'CART_TTL_DAYS' | 'SESSION_SECRET'>;
  /** Builds the service over the request's jar. */
  service: (jar: DemoCartJar) => CartService;
  onError?: (error: unknown) => void;
}

/** Runs a live cart handler with the demo service and rewrites its cookies. */
export async function handleDemoCartRequest(
  request: Request,
  deps: DemoCartRequestDeps,
  run: (handlerDeps: CartHandlerDeps) => Promise<Response>,
): Promise<Response> {
  const secret = deps.env.SESSION_SECRET;
  const state: { written: DemoCartLine[] | null } = { written: null };
  const jar: DemoCartJar = {
    read: () =>
      Promise.resolve(decodeDemoCart(requestCookies(request).get(DEMO_CART_COOKIE)?.value, secret)),
    write: (lines) => {
      state.written = lines;
    },
  };
  const response = await run({
    service: deps.service(jar),
    env: deps.env,
    ...(deps.onError ? { onError: deps.onError } : {}),
  });

  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie') continue;
    headers.append(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) {
    if (!cookie.startsWith(`${CART_COOKIE}=`)) headers.append('Set-Cookie', cookie);
  }
  const lines = state.written;
  if (lines !== null) {
    headers.append(
      'Set-Cookie',
      demoCartSetCookie(lines.length > 0 ? encodeDemoCart(lines, secret) : null, deps.env),
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
