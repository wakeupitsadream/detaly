/**
 * Next 16 proxy (formerly middleware; Node.js runtime).
 *
 * 1. Rate limits per HMAC(SESSION_SECRET, client ip bucket), see server/rate-limit.ts and the
 *    classifier in server/request-limits.ts:
 *    - search (/search, /api/search): 20 per minute and 300 per day. Not counted: requests
 *      without a query, genuine router prefetches of /search, and HEAD, which is answered here
 *      without running the search (Next would run the GET handler for it); every other method
 *      counts (server/search-request.ts);
 *    - checkout (POST /api/checkout): 10 per hour;
 *    - cancel (POST /api/orders/<token>/cancel): 5 per hour;
 *    - pay (POST /api/orders/<token>/pay): 10 per hour;
 *    - order_action (POST /api/orders/<token>/actions): 20 per hour;
 *    - cart (writes to /api/cart and /api/cart/**): 120 per hour.
 *    The YooKassa webhook is not limited (its handler checks the IP allowlist) but gets
 *    Cache-Control: no-store.
 *    A write with a foreign Origin is not counted: its handler answers 403, and counting it
 *    would let another site lock the visitor's bucket (request-limits.ts).
 *    Over the limit: 429 with Retry-After and Cache-Control: no-store; JSON for /api/ unless
 *    the client asks for text/html (a form navigation, e.g. the cart without JS), a short HTML
 *    page otherwise. Redis down: fail open with a warning (the search answers 503 itself,
 *    because Rossko is never called without its limiter; cancel is still closed by the
 *    per-order failure counter in its handler).
 * 2. /admin and /api/admin/* (decision Б25, server/admin-auth.ts): without ADMIN_BASIC_AUTH
 *    404; no or wrong Basic credentials 401 with WWW-Authenticate; wrong passwords are limited
 *    to 20 per hour per client bucket (admin_auth), and while that window is full every
 *    request of the bucket gets 429, the right password included. Redis down: the gate still
 *    checks the password, only the counter fails open (with a warning). Every admin response
 *    carries X-Robots-Tag noindex, Cache-Control no-store and Referrer-Policy no-referrer.
 * 3. Headers: X-Robots-Tag always on /search, /cart and /checkout, everywhere when
 *    NOINDEX_ALL=true (stage); the order page /o/* and /api/orders/* also get
 *    Referrer-Policy: no-referrer (the token is in the URL) and Cache-Control: no-store. This
 *    runs here and not in next.config headers() because the same image serves prod and stage;
 *    proxy response headers are applied after the next.config ones (Next's resolve-routes
 *    copies them onto the response later), and next.config keeps its global Referrer-Policy
 *    off /o/ anyway.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  ADMIN_CHALLENGE,
  ADMIN_RESPONSE_HEADERS,
  checkAdminAuth,
  isAdminPath,
} from './server/admin-auth';
import { getClientIp } from './server/client-ip';
import { serverEnv, type Env } from './server/env';
import { getLogger } from './server/logger';
import {
  hitRateLimit,
  peekRateLimit,
  type RateLimitDecision,
  type RateLimitKind,
} from './server/rate-limit';
import { getRedis } from './server/redis';
import {
  canonicalPath,
  classifyLimitedRequest,
  isForeignOriginWrite,
} from './server/request-limits';
import { withTimeout } from './server/timeout';

const NOINDEX = 'noindex, nofollow';
const RATE_LIMIT_TIMEOUT_MS = 1_000;

async function decide(
  request: NextRequest,
  env: Env,
  kind: RateLimitKind,
  mode: 'hit' | 'peek' = 'hit',
): Promise<RateLimitDecision | null> {
  try {
    const limiter = mode === 'hit' ? hitRateLimit : peekRateLimit;
    return await withTimeout(
      limiter(getRedis(), {
        kind,
        secret: env.SESSION_SECRET,
        ip: getClientIp(request.headers, env.TRUSTED_IP_HEADER),
      }),
      RATE_LIMIT_TIMEOUT_MS,
      'rate limit',
    );
  } catch (error) {
    getLogger().warn(
      { kind, mode, err: error instanceof Error ? error.message : String(error) },
      'rate limit unavailable, failing open',
    );
    return null;
  }
}

const TOO_MANY = 'Слишком много запросов';

function retryText(seconds: number): string {
  if (seconds < 90) return `через ${seconds} с`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `через ${minutes} мин`;
  return `через ${Math.ceil(minutes / 60)} ч`;
}

/** Where the HTML 429 page sends the visitor back to. */
const BACK_LINKS: Record<RateLimitKind, { href: string; label: string }> = {
  search: { href: '/', label: 'На главную' },
  checkout: { href: '/cart', label: 'Вернуться в корзину' },
  cancel: { href: '/', label: 'На главную' },
  cart: { href: '/cart', label: 'Вернуться в корзину' },
  pay: { href: '/', label: 'На главную' },
  order_action: { href: '/', label: 'На главную' },
  admin_auth: { href: '/admin', label: 'Попробовать снова' },
};

/** Order access tokens are base64url (server/orders/access.ts); anything else gets no link. */
const ORDER_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Back link of the HTML 429 page: a form on /o/<token> (pay, order actions) returns to its
 * order page; the token is already in the URL the visitor posted to.
 */
function backLink(kind: RateLimitKind, path: string): { href: string; label: string } {
  if (kind === 'pay' || kind === 'order_action') {
    const token = path.split('/')[3];
    if (token && ORDER_TOKEN_RE.test(token)) {
      return { href: `/o/${token}`, label: 'Вернуться к заказу' };
    }
  }
  return BACK_LINKS[kind];
}

function wantsHtml(request: NextRequest): boolean {
  return (request.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

function tooManyResponse(
  request: NextRequest,
  path: string,
  kind: RateLimitKind,
  retryAfterSec: number,
): NextResponse {
  const headers = {
    'Retry-After': String(retryAfterSec),
    'Cache-Control': 'no-store',
    'X-Robots-Tag': NOINDEX,
  };
  const message = `${TOO_MANY}. Попробуйте ${retryText(retryAfterSec)}.`;
  if (path.startsWith('/api/') && !wantsHtml(request)) {
    return NextResponse.json(
      { error: 'rate_limited', message, retryAfterSec },
      { status: 429, headers },
    );
  }
  const back = backLink(kind, path);
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${TOO_MANY}</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;margin:0;padding:48px 16px;color:#1c1917;background:#fafaf9}main{max-width:32rem;margin:0 auto}h1{font-size:1.5rem}a{color:#b45309}</style>
</head><body><main>
<h1>${TOO_MANY}</h1>
<p>${message}</p>
<p><a href="${back.href}">${back.label}</a></p>
</main></body></html>`;
  return new NextResponse(html, {
    status: 429,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** HEAD of a search: headers only, without spending a supplier call or the visitor's limit. */
function headResponse(path: string): NextResponse {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Content-Type': path.startsWith('/api/') ? 'application/json' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': NOINDEX,
    },
  });
}

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Order page and its API: the URL carries the order's access token. */
function isOrderPath(path: string): boolean {
  return under(path, '/o') || under(path, '/api/orders');
}

/** Payment provider callbacks: never cached by anything in between. */
function isWebhookPath(path: string): boolean {
  return under(path, '/api/webhooks');
}

function isNoindexPath(path: string): boolean {
  return path === '/search' || under(path, '/cart') || under(path, '/checkout');
}

/** Path-dependent response headers; applied to every response the proxy produces. */
function applyPathHeaders(response: NextResponse, path: string, env: Env): NextResponse {
  if (isOrderPath(path)) {
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Robots-Tag', NOINDEX);
    response.headers.set('Cache-Control', 'no-store');
  } else if (isWebhookPath(path)) {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', NOINDEX);
  } else if (env.NOINDEX_ALL || isNoindexPath(path)) {
    response.headers.set('X-Robots-Tag', NOINDEX);
  }
  return response;
}

function withAdminHeaders(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(ADMIN_RESPONSE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

function adminText(text: string, status: number, headers: Record<string, string> = {}) {
  return withAdminHeaders(
    new NextResponse(text, {
      status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
    }),
  );
}

/**
 * The /admin gate (decision Б25). A request without credentials is the browser's first try:
 * it gets the challenge without touching the wrong-password counter.
 */
async function adminGate(request: NextRequest, env: Env): Promise<NextResponse> {
  const auth = checkAdminAuth(request.headers, env.ADMIN_BASIC_AUTH);
  if (auth === 'disabled') return adminText('Not Found', 404);
  const challenge = () =>
    adminText('Нужны логин и пароль администратора', 401, {
      'WWW-Authenticate': ADMIN_CHALLENGE,
    });
  const tooMany = (decision: RateLimitDecision) =>
    adminText(`${TOO_MANY}. Попробуйте ${retryText(decision.retryAfterSec)}.`, 429, {
      'Retry-After': String(decision.retryAfterSec),
    });
  if (auth === 'missing') return challenge();
  if (auth === 'invalid') {
    const decision = await decide(request, env, 'admin_auth', 'hit');
    getLogger().warn({ path: 'admin', limited: decision?.allowed === false }, 'admin auth failed');
    return decision && !decision.allowed ? tooMany(decision) : challenge();
  }
  const decision = await decide(request, env, 'admin_auth', 'peek');
  if (decision && !decision.allowed) return tooMany(decision);
  return withAdminHeaders(NextResponse.next());
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let env: Env;
  try {
    env = serverEnv();
  } catch (error) {
    // Invalid env: let the route render its own error instead of failing every asset here.
    console.error('[proxy] invalid environment', error instanceof Error ? error.message : error);
    // The admin never opens without a validated ADMIN_BASIC_AUTH.
    if (isAdminPath(request.nextUrl.pathname)) return adminText('Not Found', 404);
    return NextResponse.next();
  }
  const { pathname } = request.nextUrl;
  // Decoded and normalized, so `/o//token/` or `/%6f/token` gets the same headers.
  const path = canonicalPath(pathname);
  if (isAdminPath(pathname)) return adminGate(request, env);

  const limited = classifyLimitedRequest({
    method: request.method,
    pathname,
    searchParams: request.nextUrl.searchParams,
    headers: request.headers,
  });
  if (limited.action === 'head') return applyPathHeaders(headResponse(path), path, env);
  // A cross-site write is answered 403 by its handler; it must not spend the visitor's limit.
  const counted =
    limited.action === 'count' &&
    (limited.kind === 'search' || !isForeignOriginWrite(request.headers, env.APP_BASE_URL));
  if (counted) {
    const decision = await decide(request, env, limited.kind);
    if (decision && !decision.allowed) {
      return applyPathHeaders(
        tooManyResponse(request, path, limited.kind, decision.retryAfterSec),
        path,
        env,
      );
    }
  }

  return applyPathHeaders(NextResponse.next(), path, env);
}

export const config = {
  // Every path, build assets included: an exclusion such as `_next/static` is matched against
  // the raw path, so `/_next/static/../../search?q=…` skipped the proxy while Next still routed
  // it to /search. The work above is one cached env lookup and a path check for other paths.
  matcher: '/:path*',
};
