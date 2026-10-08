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

const { demoBlockedPath, demoFormRedirect, proxy } = await import('@/proxy');
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

  it('the not-found page of a hidden path is rendered with the script nonce (tech-3)', async () => {
    for (const path of ['/admin', '/o/abcdefghijklmnopqrstu', '/p/abcdefghijklmnopqrstu']) {
      const response = await proxy(request('GET', path));
      expect(response.headers.get('x-middleware-rewrite'), path).toMatch(/\/_demo\/not-found$/);
      const csp = response.headers.get('content-security-policy');
      expect(csp, path).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
      // Next reads the nonce from the request it renders: the rewrite hands the policy on.
      expect(response.headers.get('x-middleware-request-content-security-policy'), path).toBe(csp);
    }
    // The demo's 303 and 404 JSON answers carry the policy as well.
    const form = await proxy(request('POST', '/api/vin'));
    expect(form.status).toBe(303);
    expect(form.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    const api = await proxy(request('POST', '/api/webhooks/yookassa'));
    expect(api.status).toBe(404);
    expect(api.headers.get('content-security-policy')).toContain("'strict-dynamic'");
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

describe('demo proxy: phase 1C forms and pages (decision С21)', () => {
  it('classifies the proposal and VIN confirmation paths', () => {
    expect(demoBlockedPath('/p/demo')).toBeNull();
    expect(demoBlockedPath('/p/AbCdEf0123456789AbCdEf0123456789')).toBe('page');
    expect(demoBlockedPath('/api/proposals/demo/take')).toBeNull();
    expect(demoBlockedPath('/api/proposals/AbCdEf0123456789/take')).toBe('api');
    expect(demoBlockedPath('/vin/sent')).toBeNull();
    expect(demoBlockedPath('/vin/sent/AbCdEf0123456789')).toBe('page');
    expect(demoBlockedPath('/vin')).toBeNull();
    expect(demoBlockedPath('/api/vin')).toBeNull();
  });

  it('answers the demo forms with 303 without reading the body', () => {
    expect(demoFormRedirect('POST', '/api/vin')).toBe('/vin/sent?demo=1');
    expect(demoFormRedirect('POST', '/api/orders/demo/link')).toBe('/o/demo?demo=link');
    expect(demoFormRedirect('POST', '/api/orders/demo/install')).toBe('/o/demo?demo=install');
    expect(demoFormRedirect('POST', '/api/orders/demo/claims')).toBe('/o/demo?demo=claim');
    expect(demoFormRedirect('GET', '/api/vin')).toBeNull();
    expect(demoFormRedirect('POST', '/api/orders/demo/cancel')).toBeNull();
    expect(demoFormRedirect('POST', '/api/orders/demo/constructor')).toBeNull();
    expect(demoFormRedirect('POST', '/api/orders/real-token/link')).toBeNull();
  });

  it('redirects the forms through the proxy, never touching the body or Redis', async () => {
    const cases = [
      ['/api/vin', '/vin/sent?demo=1'],
      ['/api/orders/demo/link', '/o/demo?demo=link'],
      ['/api/orders/demo/install', '/o/demo?demo=install'],
      ['/api/orders/demo/claims', '/o/demo?demo=claim'],
      ['/api//orders/demo/claims/', '/o/demo?demo=claim'],
    ] as const;
    for (const [path, location] of cases) {
      let bodyRead = false;
      // highWaterMark 0: the stream is pulled only when someone actually reads the body.
      const body = new ReadableStream(
        {
          pull(controller) {
            bodyRead = true;
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const form = new NextRequest(new URL(path, 'http://localhost:3000'), {
        method: 'POST',
        headers: {
          'x-real-ip': '203.0.113.7',
          origin: 'http://localhost:3000',
          'content-type': 'multipart/form-data; boundary=x',
        },
        body,
        duplex: 'half',
      } as ConstructorParameters<typeof NextRequest>[1]);
      const response = await proxy(form);
      expect(response.status, path).toBe(303);
      expect(response.headers.get('location'), path).toBe(`http://localhost:3000${location}`);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(bodyRead, path).toBe(false);
      // control: reading the body does pull the stream
      await form.arrayBuffer();
      expect(bodyRead, path).toBe(true);
    }
    expect(state.redisCalls).toBe(0);
  });

  it('builds the form redirect on APP_BASE_URL, not on the server address', async () => {
    // The standalone server sees its internal address (localhost:<port>) as the request URL.
    state.env = demoEnv({ APP_BASE_URL: 'https://demo.example' });
    const response = await proxy(request('POST', '/api/orders/demo/install'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://demo.example/o/demo?demo=install');
  });

  it('answers 404 to real proposals and VIN confirmations, serves the samples', async () => {
    const api = await proxy(request('POST', '/api/proposals/AbCdEf0123456789/take'));
    expect(api.status).toBe(404);
    for (const path of ['/p/AbCdEf0123456789', '/vin/sent/AbCdEf0123456789']) {
      const page = await proxy(request('GET', path));
      expect(page.headers.get('x-middleware-rewrite'), path).toMatch(/\/_demo\/not-found$/);
    }
    for (const path of ['/p/demo', '/vin/sent', '/vin']) {
      const page = await proxy(request('GET', path));
      expect(page.headers.get('x-middleware-next'), path).toBe('1');
    }
    const take = await proxy(request('POST', '/api/proposals/demo/take'));
    expect(take.headers.get('x-middleware-next')).toBe('1');
    expect(state.redisCalls).toBe(0);
  });

  it('«Оформить заказ» of the demo opens the sample order and empties the demo cart', async () => {
    expect(demoFormRedirect('POST', '/api/demo/checkout-done')).toBe('/o/demo');
    expect(demoFormRedirect('GET', '/api/demo/checkout-done')).toBeNull();
    const response = await proxy(request('POST', '/api/demo/checkout-done'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:3000/o/demo');
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith('demo_cart='));
    expect(cookie).toMatch(/^demo_cart=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax/);
    expect(state.redisCalls).toBe(0);
    // The other demo forms leave the cart alone.
    const vin = await proxy(request('POST', '/api/vin'));
    expect(vin.headers.getSetCookie()).toEqual([]);
  });

  it('redirects the demo forms even when the env does not parse', async () => {
    state.env = new Error('invalid env');
    const saved = process.env.DEMO_MODE;
    process.env.DEMO_MODE = 'true';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await proxy(request('POST', '/api/vin'));
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('http://localhost:3000/vin/sent?demo=1');
    } finally {
      consoleError.mockRestore();
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
