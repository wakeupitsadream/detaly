// Rate limits against the real Redis (keys under test:<uuid>:, no FLUSHDB): the phase 0
// search limit, the 1A checkout, cancel and cart limits, and src/proxy.ts end to end with its
// Redis connection replaced by one that prefixes every key.
import { createRedis, parseEnv, type Redis } from '@detaly/config';
import {
  deleteKeysByPrefix,
  minimalEnvSource,
  testKeyPrefix,
  testRedisUrl,
} from '@detaly/config/testing';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rateLimitSubject } from '@/server/client-ip';
import {
  clientBucket,
  hitRateLimit,
  hitSearchRateLimit,
  peekRateLimit,
  RATE_LIMITS,
  type RateLimitKind,
} from '@/server/rate-limit';

const SECRET = 'rate-limit-test-secret-0123456789abcdef';
const prefix = testKeyPrefix();
let redis: Redis;

const proxyState = vi.hoisted(() => ({ redis: null as unknown, env: null as unknown }));
vi.mock('@/server/redis', () => ({ getRedis: () => proxyState.redis }));
vi.mock('@/server/env', () => ({ serverEnv: () => proxyState.env }));
vi.mock('@/server/logger', () => ({ getLogger: () => ({ warn: () => undefined }) }));

beforeAll(() => {
  redis = createRedis(testRedisUrl());
  // ioredis prefixes the KEYS of EVALSHA too, so the proxy's keys land under `prefix`.
  proxyState.redis = createRedis(testRedisUrl(), { keyPrefix: prefix });
  proxyState.env = parseEnv(
    minimalEnvSource({ SESSION_SECRET: SECRET, TRUSTED_IP_HEADER: 'x-real-ip' }),
  );
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
  await (proxyState.redis as Redis).quit();
});

describe('hitSearchRateLimit', () => {
  it('lets 20 searches per minute through and rejects the 21st with Retry-After', async () => {
    const start = Date.UTC(2026, 9, 2, 6, 0, 0);
    const options = { secret: SECRET, ip: '203.0.113.7', keyPrefix: prefix };
    for (let i = 0; i < 20; i += 1) {
      const decision = await hitSearchRateLimit(redis, { ...options, now: start + i * 100 });
      expect(decision.allowed, `request ${i + 1}`).toBe(true);
    }
    const blocked = await hitSearchRateLimit(redis, { ...options, now: start + 2_100 });
    expect(blocked).toEqual({ allowed: false, retryAfterSec: 58, window: 'minute' });

    // Another client is independent.
    const other = await hitSearchRateLimit(redis, {
      ...options,
      ip: '203.0.113.8',
      now: start + 2_100,
    });
    expect(other.allowed).toBe(true);

    // A minute later the first hit has left the window.
    const later = await hitSearchRateLimit(redis, { ...options, now: start + 60_001 });
    expect(later.allowed).toBe(true);
  });

  it('caps a client at 300 searches per 24 hours', async () => {
    const start = Date.UTC(2026, 9, 3, 0, 0, 0);
    const options = { secret: SECRET, ip: '198.51.100.20', keyPrefix: prefix };
    // 15 per simulated minute keeps the minute window open.
    for (let i = 0; i < 300; i += 1) {
      const now = start + Math.floor(i / 15) * 61_000 + (i % 15);
      const decision = await hitSearchRateLimit(redis, { ...options, now });
      expect(decision.allowed, `request ${i + 1}`).toBe(true);
    }
    const blocked = await hitSearchRateLimit(redis, { ...options, now: start + 21 * 61_000 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.window).toBe('day');
    expect(blocked.retryAfterSec).toBeGreaterThan(20 * 3600);
  });

  it('stores an HMAC of the ip, never the ip itself', async () => {
    const ip = '192.0.2.55';
    await hitSearchRateLimit(redis, { secret: SECRET, ip, keyPrefix: prefix });
    const keys = await redis.keys(`${prefix}*`);
    expect(keys.some((key) => key.includes(clientBucket(SECRET, ip)))).toBe(true);
    expect(keys.some((key) => key.includes(ip))).toBe(false);
    expect(clientBucket(SECRET, ip)).not.toBe(clientBucket(`${SECRET}x`, ip));
  });
});

describe('hitRateLimit: checkout, cancel, cart, pay, order_action, admin_auth', () => {
  const HOUR_MS = 3_600_000;
  const cases: { kind: RateLimitKind; limit: number; ip: string }[] = [
    { kind: 'checkout', limit: 10, ip: '198.51.100.31' },
    { kind: 'cancel', limit: 5, ip: '198.51.100.32' },
    { kind: 'cart', limit: 120, ip: '198.51.100.33' },
    { kind: 'pay', limit: 10, ip: '198.51.100.34' },
    { kind: 'order_action', limit: 20, ip: '198.51.100.35' },
    { kind: 'admin_auth', limit: 20, ip: '198.51.100.36' },
  ];

  it('declares the hourly limits of 1A section 8 and 1B section 15', () => {
    for (const { kind, limit } of cases) {
      expect(RATE_LIMITS[kind], kind).toEqual([
        { window: 'hour', keySegment: 'hour', limit, windowMs: HOUR_MS },
      ]);
    }
  });

  for (const { kind, limit, ip } of cases) {
    it(`rejects request ${limit + 1} of ${kind} within an hour, then lets one through`, async () => {
      const start = Date.UTC(2026, 9, 4, 6, 0, 0);
      const options = { kind, secret: SECRET, ip, keyPrefix: prefix };
      for (let i = 0; i < limit; i += 1) {
        const decision = await hitRateLimit(redis, { ...options, now: start + i * 1_000 });
        expect(decision.allowed, `${kind} ${i + 1}`).toBe(true);
      }
      const blocked = await hitRateLimit(redis, { ...options, now: start + 30 * 60_000 });
      expect(blocked).toEqual({ allowed: false, retryAfterSec: 1800, window: 'hour' });

      const key = `${prefix}rl:${kind}:hour:${clientBucket(SECRET, ip)}`;
      expect(await redis.exists(key)).toBe(1);
      expect(await redis.zcard(key)).toBe(limit);

      // An hour after the first hit it has left the window.
      const later = await hitRateLimit(redis, { ...options, now: start + HOUR_MS + 1 });
      expect(later.allowed).toBe(true);
    });
  }

  it('keeps the kinds apart: an exhausted checkout leaves cart, cancel and search open', async () => {
    const now = Date.UTC(2026, 9, 4, 9, 0, 0);
    const options = { secret: SECRET, ip: '198.51.100.40', keyPrefix: prefix, now };
    for (let i = 0; i < 10; i += 1) await hitRateLimit(redis, { ...options, kind: 'checkout' });
    expect((await hitRateLimit(redis, { ...options, kind: 'checkout' })).allowed).toBe(false);
    expect((await hitRateLimit(redis, { ...options, kind: 'cart' })).allowed).toBe(true);
    expect((await hitRateLimit(redis, { ...options, kind: 'cancel' })).allowed).toBe(true);
    expect((await hitSearchRateLimit(redis, options)).allowed).toBe(true);
  });

  it('buckets IPv6 by /64: another address of the same /64 is blocked too', async () => {
    const now = Date.UTC(2026, 9, 4, 10, 0, 0);
    const base = { kind: 'cancel' as const, secret: SECRET, keyPrefix: prefix, now };
    for (let i = 0; i < 5; i += 1) {
      const ip = `2001:db8:77:1::${(i + 1).toString(16)}`;
      expect((await hitRateLimit(redis, { ...base, ip })).allowed, ip).toBe(true);
    }
    const sameNet = await hitRateLimit(redis, { ...base, ip: '2001:db8:77:1:ffff:1:2:3' });
    expect(sameNet).toMatchObject({ allowed: false, window: 'hour' });
    const otherNet = await hitRateLimit(redis, { ...base, ip: '2001:db8:77:2::1' });
    expect(otherNet.allowed).toBe(true);

    const subject = rateLimitSubject('2001:db8:77:1::1');
    expect(subject).toBe('2001:0db8:0077:0001::/64');
    const keys = await redis.keys(`${prefix}rl:cancel:*`);
    expect(keys).toContain(`${prefix}rl:cancel:hour:${clientBucket(SECRET, subject)}`);
    // rl:<kind>:<window>:<32 hex>: no address or prefix text in the key.
    for (const key of keys) {
      expect(key.slice(prefix.length)).toMatch(/^rl:cancel:hour:[0-9a-f]{32}$/);
    }
  });
});

describe('proxy with the real limiter', () => {
  async function send(
    method: string,
    path: string,
    ip: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const { proxy } = await import('@/proxy');
    return proxy(
      new NextRequest(new URL(path, 'http://localhost:3000'), {
        method,
        headers: { 'x-real-ip': ip, ...headers },
      }),
    );
  }

  it('answers the 11th checkout of an hour with a JSON 429', async () => {
    const ip = '192.0.2.111';
    for (let i = 0; i < 10; i += 1) {
      const response = await send('POST', '/api/checkout', ip, { accept: 'application/json' });
      expect(response.headers.get('x-middleware-next'), `checkout ${i + 1}`).toBe('1');
    }
    // Reads do not count.
    expect((await send('GET', '/api/checkout', ip)).headers.get('x-middleware-next')).toBe('1');
    const blocked = await send('POST', '/api/checkout', ip, { accept: 'application/json' });
    expect(blocked.status).toBe(429);
    const retryAfter = Number(blocked.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(3500);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(blocked.headers.get('cache-control')).toBe('no-store');
    expect(blocked.headers.get('content-type')).toContain('application/json');
    expect(await blocked.json()).toMatchObject({
      error: 'rate_limited',
      retryAfterSec: retryAfter,
    });

    // The key is under the test prefix and holds an HMAC, not the ip.
    const keys = await redis.keys(`${prefix}rl:checkout:hour:*`);
    expect(keys).toContain(`${prefix}rl:checkout:hour:${clientBucket(SECRET, ip)}`);
    expect(keys.some((key) => key.includes(ip))).toBe(false);
    // Another client is unaffected.
    const other = await send('POST', '/api/checkout', '192.0.2.112');
    expect(other.headers.get('x-middleware-next')).toBe('1');
  });

  it('answers the 6th cancel of an hour with a 429 and keeps the order API private', async () => {
    for (let i = 0; i < 5; i += 1) {
      // Any address of the same /64 shares the bucket.
      const response = await send('POST', '/api/orders/TokenA/cancel', `2001:db8:99:5::${i + 1}`);
      expect(response.headers.get('x-middleware-next'), `cancel ${i + 1}`).toBe('1');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
    const blocked = await send('POST', '/api/orders/TokenB/cancel', '2001:db8:99:5::10');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).not.toBeNull();
    expect(blocked.headers.get('content-type')).toContain('application/json');
    expect(blocked.headers.get('referrer-policy')).toBe('no-referrer');
    expect(blocked.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const otherNet = await send('POST', '/api/orders/TokenB/cancel', '2001:db8:99:6::1');
    expect(otherNet.headers.get('x-middleware-next')).toBe('1');
  });

  it('answers the 121st cart write of an hour with an HTML page to a form', async () => {
    const ip = '192.0.2.121';
    const form = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };
    const methods = ['POST', 'PATCH', 'DELETE'];
    for (let i = 0; i < 120; i += 1) {
      const method = methods[i % methods.length] ?? 'POST';
      const response = await send(method, `/api/cart/items/${i}`, ip, form);
      expect(response.headers.get('x-middleware-next'), `cart ${i + 1}`).toBe('1');
    }
    expect((await send('GET', '/api/cart', ip)).headers.get('x-middleware-next')).toBe('1');
    const page = await send('POST', '/api/cart/items', ip, form);
    expect(page.status).toBe(429);
    expect(page.headers.get('retry-after')).not.toBeNull();
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toContain('Вернуться в корзину');
    const json = await send('POST', '/api/cart/items', ip);
    expect(json.status).toBe(429);
    expect(json.headers.get('content-type')).toContain('application/json');
  });

  it('answers the 11th pay of an hour with a 429 that leads back to the order', async () => {
    const ip = '192.0.2.131';
    const token = 'PayToken_0123456789abcdef';
    const form = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };
    for (let i = 0; i < 10; i += 1) {
      const response = await send('POST', `/api/orders/${token}/pay`, ip, form);
      expect(response.headers.get('x-middleware-next'), `pay ${i + 1}`).toBe('1');
    }
    // Order actions have their own allowance.
    const action = await send('POST', `/api/orders/${token}/actions`, ip);
    expect(action.headers.get('x-middleware-next')).toBe('1');
    const blocked = await send('POST', `/api/orders/${token}/pay`, ip, form);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await blocked.text()).toContain(`href="/o/${token}"`);
  });
});

describe('peekRateLimit', () => {
  it('reports a full window without recording a hit', async () => {
    const start = Date.UTC(2026, 9, 5, 6, 0, 0);
    const options = { kind: 'admin_auth' as const, secret: SECRET, ip: '198.51.100.70' };
    const withPrefix = { ...options, keyPrefix: prefix };
    expect(await peekRateLimit(redis, { ...withPrefix, now: start })).toEqual({
      allowed: true,
      retryAfterSec: 0,
      window: null,
    });
    for (let i = 0; i < 20; i += 1) {
      await hitRateLimit(redis, { ...withPrefix, now: start + i * 1_000 });
    }
    const key = `${prefix}rl:admin_auth:hour:${clientBucket(SECRET, options.ip)}`;
    expect(await redis.zcard(key)).toBe(20);
    const full = await peekRateLimit(redis, { ...withPrefix, now: start + 600_000 });
    expect(full).toEqual({ allowed: false, retryAfterSec: 3000, window: 'hour' });
    expect(await redis.zcard(key)).toBe(20);
    // Once the first hit leaves the window there is room again.
    const later = await peekRateLimit(redis, { ...withPrefix, now: start + 3_600_001 });
    expect(later.allowed).toBe(true);
  });
});

describe('proxy /admin gate with the real limiter', () => {
  const ADMIN = 'admin:e2e-admin-password';
  const basic = (credentials: string) => ({
    authorization: `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`,
  });

  async function send(path: string, ip: string, headers: Record<string, string> = {}) {
    const { proxy } = await import('@/proxy');
    return proxy(
      new NextRequest(new URL(path, 'http://localhost:3000'), {
        method: 'GET',
        headers: { 'x-real-ip': ip, ...headers },
      }),
    );
  }

  it('locks the bucket after 20 wrong passwords, the right one included', async () => {
    const previous = proxyState.env;
    proxyState.env = parseEnv(
      minimalEnvSource({
        SESSION_SECRET: SECRET,
        TRUSTED_IP_HEADER: 'x-real-ip',
        ADMIN_BASIC_AUTH: ADMIN,
      }),
    );
    try {
      const ip = '192.0.2.150';
      // The browser's first request without credentials costs nothing.
      for (let i = 0; i < 25; i += 1) expect((await send('/admin', ip)).status).toBe(401);
      expect((await send('/admin', ip, basic(ADMIN))).headers.get('x-middleware-next')).toBe('1');
      for (let i = 0; i < 20; i += 1) {
        const response = await send('/admin', ip, basic(`admin:guess-${i}`));
        expect(response.status, `guess ${i + 1}`).toBe(401);
      }
      const blocked = await send('/admin', ip, basic('admin:guess-21'));
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(3500);
      const right = await send('/admin', ip, basic(ADMIN));
      expect(right.status).toBe(429);
      expect(right.headers.get('cache-control')).toBe('no-store');
      // Another client is not affected.
      const other = await send('/admin', '192.0.2.151', basic(ADMIN));
      expect(other.headers.get('x-middleware-next')).toBe('1');
      const keys = await redis.keys(`${prefix}rl:admin_auth:hour:*`);
      expect(keys).toContain(`${prefix}rl:admin_auth:hour:${clientBucket(SECRET, ip)}`);
      expect(keys.some((key) => key.includes(ip))).toBe(false);
    } finally {
      proxyState.env = previous;
    }
  });
});
