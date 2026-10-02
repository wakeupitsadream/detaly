// src/proxy.ts with env, Redis, logger and the limiter replaced: routing to the right limit,
// the 429 shapes and the path headers. The real limiter against Redis is in
// rate-limit.int.test.ts.
import { parseEnv, type Env } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RateLimitModule from '@/server/rate-limit';
import type { RateLimitDecision, RateLimitOptions } from '@/server/rate-limit';

const state = vi.hoisted(() => ({
  env: null as unknown,
  hit: null as unknown as (options: unknown) => Promise<unknown>,
  warn: null as unknown as (...args: unknown[]) => void,
}));

vi.mock('@/server/env', () => ({ serverEnv: () => state.env }));
vi.mock('@/server/redis', () => ({ getRedis: () => ({ fake: 'redis' }) }));
vi.mock('@/server/logger', () => ({
  getLogger: () => ({ warn: (...args: unknown[]) => state.warn(...args) }),
}));
vi.mock('@/server/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof RateLimitModule>();
  return { ...actual, hitRateLimit: (_redis: unknown, options: unknown) => state.hit(options) };
});

const { proxy } = await import('@/proxy');

const ALLOWED: RateLimitDecision = { allowed: true, retryAfterSec: 0, window: null };
const MIDDLEWARE_NEXT = 'x-middleware-next';

let hits: RateLimitOptions[];
let warnings: unknown[][];

function env(overrides: Record<string, string> = {}): Env {
  return parseEnv(minimalEnvSource({ TRUSTED_IP_HEADER: 'x-real-ip', ...overrides }));
}

function request(method: string, path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    method,
    headers: { 'x-real-ip': '203.0.113.7', ...headers },
  });
}

beforeEach(() => {
  state.env = env();
  hits = [];
  warnings = [];
  state.hit = (options) => {
    hits.push(options as RateLimitOptions);
    return Promise.resolve(ALLOWED);
  };
  state.warn = (...args) => {
    warnings.push(args);
  };
});

function rejectWith(retryAfterSec: number): void {
  state.hit = (options) => {
    hits.push(options as RateLimitOptions);
    return Promise.resolve({ allowed: false, retryAfterSec, window: 'hour' });
  };
}

describe('proxy: which limit is spent', () => {
  it('counts checkout, cancel and cart writes with the trusted client ip', async () => {
    await proxy(request('POST', '/api/checkout'));
    await proxy(request('POST', '/api/orders/tok123/cancel'));
    await proxy(request('POST', '/api/cart/items'));
    await proxy(request('PATCH', '/api/cart/items/1'));
    await proxy(request('DELETE', '/api/cart/items/1'));
    await proxy(request('GET', '/search?q=OC90'));
    expect(hits.map((hit) => hit.kind)).toEqual([
      'checkout',
      'cancel',
      'cart',
      'cart',
      'cart',
      'search',
    ]);
    expect(hits.every((hit) => hit.ip === '203.0.113.7')).toBe(true);
    expect(hits.every((hit) => hit.secret === env().SESSION_SECRET)).toBe(true);
  });

  it('uses the shared bucket when X-Real-IP is not trusted', async () => {
    state.env = env({ TRUSTED_IP_HEADER: 'none' });
    await proxy(request('POST', '/api/checkout'));
    expect(hits[0]?.ip).toBe('local');
  });

  it('does not count reads, preflights or other paths', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const response = await proxy(request(method, '/api/checkout'));
      expect(response.headers.get(MIDDLEWARE_NEXT), method).toBe('1');
      await proxy(request(method, '/api/cart/items'));
      await proxy(request(method, '/api/orders/tok123/cancel'));
    }
    await proxy(request('POST', '/'));
    await proxy(request('GET', '/cart'));
    await proxy(request('GET', '/search'));
    expect(hits).toEqual([]);
  });

  it('does not count a cross-site write: its handler answers 403 (CSRF lockout)', async () => {
    rejectWith(3600);
    const evil = { origin: 'https://evil.example' };
    for (const [method, path] of [
      ['POST', '/api/checkout'],
      ['POST', '/api/orders/tok123/cancel'],
      ['POST', '/api/cart/items'],
    ] as const) {
      const response = await proxy(request(method, path, evil));
      expect(response.headers.get(MIDDLEWARE_NEXT), path).toBe('1');
    }
    expect(hits).toEqual([]);
    // The shop's own origin and a request without Origin are counted.
    const own = await proxy(request('POST', '/api/checkout', { origin: env().APP_BASE_URL }));
    expect(own.status).toBe(429);
    const bare = await proxy(request('POST', '/api/orders/tok123/cancel'));
    expect(bare.status).toBe(429);
    // A cross-site search is still counted: it runs the search.
    const search = await proxy(request('GET', '/search?q=OC90', evil));
    expect(search.status).toBe(429);
    expect(hits.map((hit) => hit.kind)).toEqual(['checkout', 'cancel', 'search']);
  });

  it('answers HEAD of a search itself, without counting it', async () => {
    const response = await proxy(request('HEAD', '/search?q=OC90'));
    expect(response.status).toBe(200);
    expect(response.headers.get(MIDDLEWARE_NEXT)).toBeNull();
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(hits).toEqual([]);
  });
});

describe('proxy: 429', () => {
  it('answers JSON on the API with Retry-After and no-store', async () => {
    rejectWith(1800);
    const response = await proxy(request('POST', '/api/checkout', { accept: 'application/json' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1800');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get(MIDDLEWARE_NEXT)).toBeNull();
    expect(await response.json()).toEqual({
      error: 'rate_limited',
      message: 'Слишком много запросов. Попробуйте через 30 мин.',
      retryAfterSec: 1800,
    });
  });

  it('answers JSON to fetch without an Accept header', async () => {
    rejectWith(3600);
    const response = await proxy(request('POST', '/api/orders/tok123/cancel'));
    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe('Слишком много запросов. Попробуйте через 60 мин.');
    // The order API keeps its private headers on the 429 too.
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('answers an HTML page to a form navigation (cart without JS)', async () => {
    rejectWith(125);
    const response = await proxy(
      request('POST', '/api/cart/items', {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('125');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain('<h1>Слишком много запросов</h1>');
    expect(html).toContain('через 3 мин');
    expect(html).toContain('<a href="/cart">Вернуться в корзину</a>');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it('keeps the phase 0 search answers', async () => {
    rejectWith(58);
    const page = await proxy(request('GET', '/search?q=OC90'));
    expect(page.status).toBe(429);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toContain('<a href="/">На главную</a>');
    const api = await proxy(request('GET', '/api/search?q=OC90'));
    expect(api.status).toBe(429);
    expect(api.headers.get('retry-after')).toBe('58');
    expect(((await api.json()) as { retryAfterSec: number }).retryAfterSec).toBe(58);
  });

  it('fails open with a warning when Redis is unavailable', async () => {
    state.hit = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    const response = await proxy(request('POST', '/api/checkout'));
    expect(response.headers.get(MIDDLEWARE_NEXT)).toBe('1');
    expect(response.status).toBe(200);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toMatchObject({ kind: 'checkout' });
    expect(warnings[0]?.[1]).toBe('rate limit unavailable, failing open');
    // No client ip in the log line.
    expect(JSON.stringify(warnings)).not.toContain('203.0.113.7');
  });
});

describe('proxy: path headers', () => {
  it('makes the order page and its API private', async () => {
    for (const path of ['/o/AbCdEf123', '/o/AbCdEf123/', '/%6f/AbCdEf123', '/api/orders/x']) {
      const response = await proxy(request('GET', path));
      expect(response.headers.get(MIDDLEWARE_NEXT), path).toBe('1');
      expect(response.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('marks /cart and /checkout noindex without other changes', async () => {
    for (const path of ['/cart', '/cart?added=1', '/checkout?part=local', '/checkout/']) {
      const response = await proxy(request('GET', path));
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
      expect(response.headers.get('referrer-policy'), path).toBeNull();
      expect(response.headers.get('cache-control'), path).toBeNull();
    }
  });

  it('keeps /search noindex and leaves public pages alone', async () => {
    const search = await proxy(request('GET', '/search'));
    expect(search.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    for (const path of ['/', '/about', '/docs/offer', '/office', '/cartridge', '/api/health']) {
      const response = await proxy(request('GET', path));
      expect(response.headers.get('x-robots-tag'), path).toBeNull();
      expect(response.headers.get('referrer-policy'), path).toBeNull();
    }
  });

  it('marks everything noindex on stage (NOINDEX_ALL)', async () => {
    state.env = env({ NOINDEX_ALL: 'true' });
    const response = await proxy(request('GET', '/about'));
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});
