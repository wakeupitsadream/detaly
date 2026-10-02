// Search rate limit against the real Redis (keys under test:<uuid>:, no FLUSHDB).
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientBucket, hitSearchRateLimit } from '@/server/rate-limit';

const SECRET = 'rate-limit-test-secret-0123456789abcdef';
const prefix = testKeyPrefix();
let redis: Redis;

beforeAll(() => {
  redis = createRedis(testRedisUrl());
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
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
