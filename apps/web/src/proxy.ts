/**
 * Next 16 proxy (formerly middleware; Node.js runtime).
 *
 * 1. Search rate limit on /search and /api/search: 20 per minute and 300 per day per
 *    HMAC(SESSION_SECRET, client ip). HEAD and prefetch requests are not counted, nor are
 *    requests without a query (they never reach Rossko). Over the limit: JSON 429 with
 *    Retry-After for the API, a short HTML 429 page for /search. Redis down: fail open
 *    (the search itself then answers 503, because Rossko is never called without its limiter).
 * 2. X-Robots-Tag: always on /search, everywhere when NOINDEX_ALL=true (stage). This runs here
 *    and not in next.config headers() because the same image serves prod and stage.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from './server/client-ip';
import { serverEnv, type Env } from './server/env';
import { getLogger } from './server/logger';
import { hitSearchRateLimit, type RateLimitDecision } from './server/rate-limit';
import { getRedis } from './server/redis';
import { withTimeout } from './server/timeout';

const LIMITED_PATHS = new Set(['/search', '/api/search']);
const NOINDEX = 'noindex, nofollow';
const RATE_LIMIT_TIMEOUT_MS = 1_000;

function isPrefetch(request: NextRequest): boolean {
  const headers = request.headers;
  // Visible here thanks to skipProxyUrlNormalize in next.config.ts.
  return (
    headers.has('next-router-prefetch') ||
    headers.has('next-router-segment-prefetch') ||
    headers.get('purpose') === 'prefetch' ||
    (headers.get('sec-purpose') ?? '').includes('prefetch')
  );
}

function shouldCount(request: NextRequest): boolean {
  if (request.method !== 'GET') return false;
  if (!LIMITED_PATHS.has(request.nextUrl.pathname)) return false;
  if (isPrefetch(request)) return false;
  return (request.nextUrl.searchParams.get('q') ?? '').trim() !== '';
}

async function decide(request: NextRequest, env: Env): Promise<RateLimitDecision | null> {
  try {
    return await withTimeout(
      hitSearchRateLimit(getRedis(), {
        secret: env.SESSION_SECRET,
        ip: getClientIp(request.headers, env.TRUSTED_IP_HEADER),
      }),
      RATE_LIMIT_TIMEOUT_MS,
      'rate limit',
    );
  } catch (error) {
    getLogger().warn(
      { err: error instanceof Error ? error.message : String(error) },
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

function tooManyResponse(pathname: string, retryAfterSec: number): NextResponse {
  const headers = {
    'Retry-After': String(retryAfterSec),
    'Cache-Control': 'no-store',
    'X-Robots-Tag': NOINDEX,
  };
  const message = `${TOO_MANY}. Попробуйте ${retryText(retryAfterSec)}.`;
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'rate_limited', message, retryAfterSec },
      { status: 429, headers },
    );
  }
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${TOO_MANY}</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;margin:0;padding:48px 16px;color:#1c1917;background:#fafaf9}main{max-width:32rem;margin:0 auto}h1{font-size:1.5rem}a{color:#b45309}</style>
</head><body><main>
<h1>${TOO_MANY}</h1>
<p>${message}</p>
<p><a href="/">На главную</a></p>
</main></body></html>`;
  return new NextResponse(html, {
    status: 429,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
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

  if (shouldCount(request)) {
    const decision = await decide(request, env);
    if (decision && !decision.allowed) return tooManyResponse(pathname, decision.retryAfterSec);
  }

  const response = NextResponse.next();
  if (env.NOINDEX_ALL || pathname === '/search') {
    response.headers.set('X-Robots-Tag', NOINDEX);
  }
  return response;
}

export const config = {
  // Everything except build assets; the work above is cheap for non-search paths.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};
