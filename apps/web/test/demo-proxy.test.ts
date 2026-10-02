// src/proxy.ts in DEMO_MODE: the paths that do not exist without a database answer 404, the
// rate limits are counted in memory and Redis is never asked for (getRedis would throw).
import { parseEnv, type Env } from '@detaly/config';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRateLimiter } from '@/server/demo/rate-limit';
import { RATE_LIMITS } from '@/server/rate-limit';

const state = vi.hoisted(() => ({ env: null as unknown, redisCalls: 0 }));

vi.mock('@/server/env', () => ({
  serverEnv: () => {
    if (state.env instanceof Error) throw state.env;
    return state.env;
  },
}));
vi.mock('@/server/redis', () => ({
  getRedis: () => {
    state.redisCalls += 1;
    throw new Error('redis must not be used in the demo');
  },
}));
vi.mock('@/server/logger', () => ({ getLogger: () => ({ warn: () => undefined }) }));

const { demoBlockedPath, proxy } = await import('@/proxy');
const { resetSingleton } = await import('@/server/globals');

function demoEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    DEMO_MODE: 'true',
    TRUSTED_IP_HEADER: 'x-real-ip',
    ...overrides,
  });
}

function request(method: string, path: string, ip = '203.0.113.7'): NextRequest {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    method,
    headers: { 'x-real-ip': ip, origin: 'http://localhost:3000' },
  });
}

beforeEach(() => {
  state.env = demoEnv();
  state.redisCalls = 0;
  resetSingleton('demo-rate-limit');
});

describe('demo proxy: hidden paths', () => {
  it('classifies the paths a demo does not have', () => {
    expect(demoBlockedPath('/admin')).toBe('page');
    expect(demoBlockedPath('/admin/orders/1')).toBe('page');
    expect(demoBlockedPath('/api/admin/orders/1/actions')).toBe('api');
    expect(demoBlockedPath('/api/webhooks/yookassa')).toBe('api');
    expect(demoBlockedPath('/api/orders/abc/cancel')).toBe('api');
    expect(demoBlockedPath('/o/some-real-looking-token-1234')).toBe('page');
    expect(demoBlockedPath('/o/demo')).toBeNull();
    expect(demoBlockedPath('/')).toBeNull();
    expect(demoBlockedPath('/search')).toBeNull();
    expect(demoBlockedPath('/cart')).toBeNull();
    expect(demoBlockedPath('/api/cart/items')).toBeNull();
    expect(demoBlockedPath('/api/health')).toBeNull();
    expect(demoBlockedPath('/docs/offer')).toBeNull();
  });

  it('answers 404 JSON to the admin API, webhooks and the order API', async () => {
    for (const path of [
      '/api/webhooks/yookassa',
      '/api/orders/abcdefghijklmnop/cancel',
      '/api/admin/orders/1/actions',
    ]) {
      const response = await proxy(request('POST', path));
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(state.redisCalls).toBe(0);
  });

  it('sends /admin and real order pages to the not-found page', async () => {
    for (const path of ['/admin', '/admin/orders/1', '/o/abcdefghijklmnopqrstu', '/%6f/x']) {
      const response = await proxy(request('GET', path));
      expect(response.headers.get('x-middleware-rewrite'), path).toMatch(/\/_demo\/not-found$/);
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
  });

  it('serves the sample order and the storefront as usual', async () => {
    for (const path of ['/o/demo', '/', '/cart', '/docs/offer', '/api/health']) {
      const response = await proxy(request('GET', path));
      expect(response.headers.get('x-middleware-next'), path).toBe('1');
      // A demo is never indexed, whatever NOINDEX_ALL says.
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
    }
    const order = await proxy(request('GET', '/o/demo'));
    expect(order.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('hides the same paths when the env does not even parse', async () => {
    state.env = new Error('invalid env');
    const saved = process.env.DEMO_MODE;
    process.env.DEMO_MODE = 'true';
    try {
      const webhook = await proxy(request('POST', '/api/webhooks/yookassa'));
      expect(webhook.status).toBe(404);
      const admin = await proxy(request('GET', '/admin'));
      expect(admin.status).toBe(404);
    } finally {
      if (saved === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = saved;
    }
  });
});

describe('demo proxy: rate limits in memory', () => {
  it('limits searches per client without Redis', async () => {
    const limit = RATE_LIMITS.search[0].limit;
    for (let i = 0; i < limit; i += 1) {
      const response = await proxy(request('GET', `/search?q=OC90&n=${i}`));
      expect(response.headers.get('x-middleware-next')).toBe('1');
    }
    const blocked = await proxy(request('GET', '/api/search?q=OC90'));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another client has its own bucket.
    const other = await proxy(request('GET', '/search?q=OC90', '198.51.100.9'));
    expect(other.headers.get('x-middleware-next')).toBe('1');
    expect(state.redisCalls).toBe(0);
  });

  it('counts the checkout refusal on its own limit', async () => {
    const limit = RATE_LIMITS.checkout[0].limit;
    for (let i = 0; i < limit; i += 1) {
      expect((await proxy(request('POST', '/api/checkout'))).headers.get('x-middleware-next')).toBe(
        '1',
      );
    }
    expect((await proxy(request('POST', '/api/checkout'))).status).toBe(429);
  });
});

describe('createMemoryRateLimiter', () => {
  const base = { secret: 'test-session-secret-0123456789abcdef', ip: '203.0.113.7' };

  it('slides the window and does not count rejected requests', () => {
    const limiter = createMemoryRateLimiter();
    const start = Date.UTC(2026, 9, 2, 9, 0, 0);
    for (let i = 0; i < 20; i += 1) {
      expect(limiter.hit({ ...base, kind: 'search', now: start + i }).allowed).toBe(true);
    }
    const rejected = limiter.hit({ ...base, kind: 'search', now: start + 1_000 });
    expect(rejected).toMatchObject({ allowed: false, window: 'minute', retryAfterSec: 59 });
    // A minute after the first hit one slot is free again.
    expect(limiter.hit({ ...base, kind: 'search', now: start + 60_001 }).allowed).toBe(true);
  });

  it('keeps a bounded number of buckets', () => {
    const limiter = createMemoryRateLimiter(4);
    for (let i = 0; i < 10; i += 1) {
      limiter.hit({ ...base, ip: `203.0.113.${i}`, kind: 'checkout' });
    }
    // Still answers (old buckets were dropped, not an error).
    expect(limiter.hit({ ...base, kind: 'checkout' }).allowed).toBe(true);
  });
});
