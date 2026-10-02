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
 *    - cart (writes to /api/cart and /api/cart/**): 120 per hour.
 *    Over the limit: 429 with Retry-After and Cache-Control: no-store; JSON for /api/ unless
 *    the client asks for text/html (a form navigation, e.g. the cart without JS), a short HTML
 *    page otherwise. Redis down: fail open with a warning (the search answers 503 itself,
 *    because Rossko is never called without its limiter; cancel is still closed by the
 *    per-order failure counter in its handler).
 * 2. Headers: X-Robots-Tag always on /search, /cart and /checkout, everywhere when
 *    NOINDEX_ALL=true (stage); the order page /o/* and /api/orders/* also get
 *    Referrer-Policy: no-referrer (the token is in the URL) and Cache-Control: no-store. This
 *    runs here and not in next.config headers() because the same image serves prod and stage;
 *    proxy response headers are applied after the next.config ones (Next's resolve-routes
 *    copies them onto the response later), and next.config keeps its global Referrer-Policy
 *    off /o/ anyway.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from './server/client-ip';
import { serverEnv, type Env } from './server/env';
import { getLogger } from './server/logger';
import { hitRateLimit, type RateLimitDecision, type RateLimitKind } from './server/rate-limit';
import { getRedis } from './server/redis';
import { canonicalPath, classifyLimitedRequest } from './server/request-limits';
import { withTimeout } from './server/timeout';

const NOINDEX = 'noindex, nofollow';
const RATE_LIMIT_TIMEOUT_MS = 1_000;

async function decide(
  request: NextRequest,
  env: Env,
  kind: RateLimitKind,
): Promise<RateLimitDecision | null> {
  try {
    return await withTimeout(
      hitRateLimit(getRedis(), {
        kind,
        secret: env.SESSION_SECRET,
        ip: getClientIp(request.headers, env.TRUSTED_IP_HEADER),
      }),
      RATE_LIMIT_TIMEOUT_MS,
      'rate limit',
    );
  } catch (error) {
    getLogger().warn(
      { kind, err: error instanceof Error ? error.message : String(error) },
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
};

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
  const back = BACK_LINKS[kind];
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

function isNoindexPath(path: string): boolean {
  return path === '/search' || under(path, '/cart') || under(path, '/checkout');
}

/** Path-dependent response headers; applied to every response the proxy produces. */
function applyPathHeaders(response: NextResponse, path: string, env: Env): NextResponse {
  if (isOrderPath(path)) {
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Robots-Tag', NOINDEX);
    response.headers.set('Cache-Control', 'no-store');
  } else if (env.NOINDEX_ALL || isNoindexPath(path)) {
    response.headers.set('X-Robots-Tag', NOINDEX);
  }
  return response;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let env: Env;
  try {
    env = serverEnv();
  } catch (error) {
    // Invalid env: let the route render its own error instead of failing every asset here.
    console.error('[proxy] invalid environment', error instanceof Error ? error.message : error);
    return NextResponse.next();
  }
  const { pathname } = request.nextUrl;
  // Decoded and normalized, so `/o//token/` or `/%6f/token` gets the same headers.
  const path = canonicalPath(pathname);

  const limited = classifyLimitedRequest({
    method: request.method,
    pathname,
    searchParams: request.nextUrl.searchParams,
    headers: request.headers,
  });
  if (limited.action === 'head') return applyPathHeaders(headResponse(path), path, env);
  if (limited.action === 'count') {
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
