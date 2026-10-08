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
 *    - cart (writes to /api/cart and /api/cart/**): 120 per hour;
 *    - phase 1C (decision С27): link (POST /api/orders/<token>/link) 20 per hour, install
 *      (POST /api/orders/<token>/install and …/install/cancel) 20 per hour, claim
 *      (POST /api/orders/<token>/claims) 10 per hour, vin (POST /api/vin) 5 per hour and 20
 *      per day, proposal (POST /api/proposals/<token>/take) 30 per hour.
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
 *    off /o/ anyway. Phase 1C: the VIN proposal /p/<token>, its API /api/proposals/* and the
 *    VIN confirmation /vin/sent/<link token> carry tokens too and get the same three headers;
 *    admin files (/api/admin/files/*) get no-store with the other admin headers.
 * 4. DEMO_MODE (docs/design.md, section 5): the rate limits are counted in memory
 *    (server/demo/rate-limit.ts, Redis is never touched); /admin, /api/admin/*,
 *    /api/webhooks/* and /api/orders/* answer 404, and so does every order page but the sample
 *    /o/demo (its handlers check the same again). Phase 1C (decision С21): the demo forms are
 *    answered here WITHOUT reading the body — POST /api/vin -> 303 /vin/sent?demo=1 (only
 *    for a client that posts it anyway: the demo VIN form has no action and no submit), POST
 *    /api/orders/demo/{link,install,claims} -> 303 /o/demo?demo=<what>, POST
 *    /api/demo/checkout-done -> 303 /o/demo with the demo cart emptied; every proposal but
 *    /p/demo (and its API) and every /vin/sent/<token> answer 404.
 * 5. Content-Security-Policy (audit tech-3, lib/csp.ts): a new script nonce for every request,
 *    the policy on every response the proxy gives, and the same policy on the request that
 *    goes on to the app (NextResponse.next / rewrite), which is where Next reads the nonce for
 *    its own scripts. No 'unsafe-inline' in script-src: a page rendered without the nonce
 *    (prerendered at build time) would lose its scripts, so every page is rendered per request.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, createNonce } from './lib/csp';
import {
  ADMIN_CHALLENGE,
  ADMIN_RESPONSE_HEADERS,
  checkAdminAuth,
  isAdminPath,
} from './server/admin-auth';
import { getClientIp } from './server/client-ip';
import { demoCartSetCookie } from './server/demo/cart-cookie';
import { DEMO_CHECKOUT_DONE_PATH } from './server/demo/checkout-done';
import { createMemoryRateLimiter } from './server/demo/rate-limit';
import { serverEnv, type Env } from './server/env';
import { singleton } from './server/globals';
import { getLogger } from './server/logger';
import { rawDemoFlag } from './server/mode';
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
  if (env.DEMO_MODE) {
    // Only searches, cart writes and the checkout refusal are counted in the demo (no admin).
    return singleton('demo-rate-limit', () => createMemoryRateLimiter()).hit({
      kind,
      secret: env.SESSION_SECRET,
      ip: getClientIp(request.headers, env.TRUSTED_IP_HEADER),
    });
  }
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
  link: { href: '/', label: 'На главную' },
  install: { href: '/', label: 'На главную' },
  claim: { href: '/', label: 'На главную' },
  vin: { href: '/vin', label: 'Вернуться к заявке' },
  proposal: { href: '/', label: 'На главную' },
};

/** Limits of forms on /o/<token>: the 429 page links back to the order. */
const ORDER_PAGE_KINDS: ReadonlySet<RateLimitKind> = new Set([
  'pay',
  'order_action',
  'link',
  'install',
  'claim',
]);

/**
 * Order access tokens and proposal tokens are base64url (server/orders/access.ts, decision
 * С13); anything else gets no link.
 */
const ORDER_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Back link of the HTML 429 page: a form on /o/<token> (pay, order actions) returns to its
 * order page; the token is already in the URL the visitor posted to.
 */
function backLink(kind: RateLimitKind, path: string): { href: string; label: string } {
  const token = path.split('/')[3];
  if (ORDER_PAGE_KINDS.has(kind) && token && ORDER_TOKEN_RE.test(token)) {
    return { href: `/o/${token}`, label: 'Вернуться к заказу' };
  }
  if (kind === 'proposal' && token && ORDER_TOKEN_RE.test(token)) {
    return { href: `/p/${token}`, label: 'Вернуться к подборке' };
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

/**
 * Pages and APIs whose URL carries a secret token: the order page and its API, the VIN
 * proposal /p/<token> and its API, the VIN confirmation /vin/sent/<link token> (phase 1C).
 */
function isOrderPath(path: string): boolean {
  return (
    under(path, '/o') ||
    under(path, '/api/orders') ||
    under(path, '/p') ||
    under(path, '/api/proposals') ||
    under(path, '/vin/sent')
  );
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
  } else if (env.NOINDEX_ALL || env.DEMO_MODE || isNoindexPath(path)) {
    // A demo is never indexed: its prices are fixtures and nothing on it can be ordered.
    response.headers.set('X-Robots-Tag', NOINDEX);
  }
  return response;
}

/** The sample order of the demo (app/(site)/o/demo/page.tsx). */
export const DEMO_ORDER_PATH = '/o/demo';

/** The sample VIN proposal of the demo (phase 1C, app/(site)/p/[token] with token `demo`). */
export const DEMO_PROPOSAL_PATH = '/p/demo';

/**
 * DEMO_MODE: paths that do not exist without a database (the admin, payment webhooks, the
 * order API, real order pages, real proposals and their API, VIN confirmations with a link
 * token). null = serve as usual.
 */
export function demoBlockedPath(path: string): 'api' | 'page' | null {
  if (under(path, '/api/admin') || isWebhookPath(path) || under(path, '/api/orders')) return 'api';
  if (under(path, '/api/proposals') && !under(path, '/api/proposals/demo')) return 'api';
  if (under(path, '/admin')) return 'page';
  if (under(path, '/o') && path !== DEMO_ORDER_PATH) return 'page';
  if (under(path, '/p') && path !== DEMO_PROPOSAL_PATH) return 'page';
  if (under(path, '/vin/sent') && path !== '/vin/sent') return 'page';
  return null;
}

/** Demo forms of the sample order: the last path segment -> `?demo=` of /o/demo. */
const DEMO_ORDER_FORMS: Readonly<Record<string, string>> = {
  link: 'link',
  install: 'install',
  claims: 'claim',
};

/**
 * DEMO_MODE (decision С21): where a demo form goes instead of its handler, or null. The proxy
 * answers 303 without reading the body, so no personal data or photo is ever accepted.
 */
export function demoFormRedirect(method: string, path: string): string | null {
  if (method.toUpperCase() !== 'POST') return null;
  if (path === '/api/vin') return '/vin/sent?demo=1';
  if (path === DEMO_CHECKOUT_DONE_PATH) return DEMO_ORDER_PATH;
  const prefix = '/api/orders/demo/';
  if (path.startsWith(prefix)) {
    const form = path.slice(prefix.length);
    if (Object.hasOwn(DEMO_ORDER_FORMS, form)) return `/o/demo?demo=${DEMO_ORDER_FORMS[form]}`;
  }
  return null;
}

/**
 * 303 to a same-site path. The Location must be absolute: Next parses the Location of a proxy
 * response without a base, so a relative one throws ERR_INVALID_URL (500 on the standalone
 * server); a Location on the request's own host is relativized again by Next. The base is
 * APP_BASE_URL (on Vercel the demo's own host, packages/config), which the same-origin checks
 * use too: the standalone server's request URL is its internal address (localhost:<port>), not
 * the public host. Only when the env does not parse does the request URL stand in.
 */
function demoSeeOther(base: string | URL, location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: {
      Location: new URL(location, base).toString(),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': NOINDEX,
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/**
 * What the app gets instead of the bare request: the same headers plus this response's CSP, the
 * header Next takes the script nonce from (lib/csp.ts). Used by every NextResponse.next() and
 * rewrite below, so no rendered page goes without its nonce.
 */
function appRequest(request: NextRequest, csp: string): { request: { headers: Headers } } {
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', csp);
  return { request: { headers } };
}

/** 404 of a demo-blocked path: JSON for the API, the site's not-found page otherwise. */
function demoNotFoundResponse(
  request: NextRequest,
  kind: 'api' | 'page',
  csp: string,
): NextResponse {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': NOINDEX };
  if (kind === 'api') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers });
  }
  // A path no route matches: Next renders app/not-found.tsx with status 404.
  const response = NextResponse.rewrite(new URL('/_demo/not-found', request.url), {
    headers,
    ...appRequest(request, csp),
  });
  response.headers.set('Referrer-Policy', 'no-referrer');
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
async function adminGate(request: NextRequest, env: Env, csp: string): Promise<NextResponse> {
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
  return withAdminHeaders(NextResponse.next(appRequest(request, csp)));
}

/** next dev: React refresh needs 'unsafe-eval' and the HMR socket in the policy. */
const DEV = process.env.NODE_ENV === 'development';

export async function proxy(request: NextRequest): Promise<NextResponse> {
  // A new nonce per request; every response of the proxy carries the policy (point 5 above).
  const csp = contentSecurityPolicy(createNonce(), { dev: DEV });
  const response = await route(request, csp);
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

async function route(request: NextRequest, csp: string): Promise<NextResponse> {
  let env: Env;
  try {
    env = serverEnv();
  } catch (error) {
    // Invalid env: let the route render its own error instead of failing every asset here.
    console.error('[proxy] invalid environment', error instanceof Error ? error.message : error);
    // The admin never opens without a validated ADMIN_BASIC_AUTH.
    if (isAdminPath(request.nextUrl.pathname)) return adminText('Not Found', 404);
    // Nor does anything a demo hides, whatever else is wrong with its env.
    if (rawDemoFlag()) {
      const path = canonicalPath(request.nextUrl.pathname);
      const redirect = demoFormRedirect(request.method, path);
      if (redirect !== null) return demoSeeOther(request.nextUrl, redirect);
      const blocked = demoBlockedPath(path);
      if (blocked !== null) {
        return demoNotFoundResponse(request, path.startsWith('/api/') ? 'api' : blocked, csp);
      }
    }
    return NextResponse.next(appRequest(request, csp));
  }
  const { pathname } = request.nextUrl;
  // Decoded and normalized, so `/o//token/` or `/%6f/token` gets the same headers.
  const path = canonicalPath(pathname);
  if (env.DEMO_MODE) {
    const redirect = demoFormRedirect(request.method, path);
    if (redirect !== null) {
      const response = demoSeeOther(env.APP_BASE_URL, redirect);
      if (path === DEMO_CHECKOUT_DONE_PATH) {
        response.headers.append('Set-Cookie', demoCartSetCookie(null, env));
      }
      return response;
    }
    const blocked = isAdminPath(pathname) ? 'page' : demoBlockedPath(path);
    if (blocked !== null) {
      return demoNotFoundResponse(request, path.startsWith('/api/') ? 'api' : blocked, csp);
    }
  }
  if (isAdminPath(pathname)) return adminGate(request, env, csp);

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

  return applyPathHeaders(NextResponse.next(appRequest(request, csp)), path, env);
}

export const config = {
  // Every path, build assets included: an exclusion such as `_next/static` is matched against
  // the raw path, so `/_next/static/../../search?q=…` skipped the proxy while Next still routed
  // it to /search. The work above is one cached env lookup and a path check for other paths.
  matcher: '/:path*',
};
