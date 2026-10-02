import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { dailyCounterGet, dailyCounterHit, slidingWindowHit } from '../src/rate-window';
import { createRedis } from '../src/redis';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '../src/testing';

let redis: Redis;
const prefix = testKeyPrefix();

beforeAll(() => {
  redis = createRedis(testRedisUrl());
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
});

describe('slidingWindowHit (real Redis)', () => {
  it('allows 20 hits per minute and rejects the 21st', async () => {
    const key = `${prefix}search:min:ip1`;
    const t0 = 1_790_000_000_000;
    for (let i = 0; i < 20; i += 1) {
      const hit = await slidingWindowHit(redis, { key, limit: 20, windowMs: 60_000, now: t0 + i });
      expect(hit).toEqual({ allowed: true, count: i + 1, retryAfterMs: 0 });
    }
    const rejected = await slidingWindowHit(redis, {
      key,
      limit: 20,
      windowMs: 60_000,
      now: t0 + 1_000,
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.count).toBe(20);
    // The oldest hit (t0) leaves the window at t0 + 60000.
    expect(rejected.retryAfterMs).toBe(59_000);

    // Rejected hits are not recorded: one slot frees up exactly at retryAfterMs.
    const stillRejected = await slidingWindowHit(redis, {
      key,
      limit: 20,
      windowMs: 60_000,
      now: t0 + 59_999,
    });
    expect(stillRejected.allowed).toBe(false);
    const allowed = await slidingWindowHit(redis, {
      key,
      limit: 20,
      windowMs: 60_000,
      now: t0 + 60_000,
    });
    expect(allowed).toEqual({ allowed: true, count: 20, retryAfterMs: 0 });

    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('keeps independent keys apart', async () => {
    const a = await slidingWindowHit(redis, { key: `${prefix}a`, limit: 1, windowMs: 1000 });
    const b = await slidingWindowHit(redis, { key: `${prefix}b`, limit: 1, windowMs: 1000 });
    const a2 = await slidingWindowHit(redis, { key: `${prefix}a`, limit: 1, windowMs: 1000 });
    expect([a.allowed, b.allowed, a2.allowed]).toEqual([true, true, false]);
  });

  it('validates arguments', async () => {
    await expect(
      slidingWindowHit(redis, { key: `${prefix}bad`, limit: 0, windowMs: 1000 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('dailyCounterHit (real Redis)', () => {
  it('counts per Moscow day and stops at the limit without consuming quota', async () => {
    const counterPrefix = `${prefix}rossko:quota`;
    const beforeMidnight = new Date('2026-10-01T20:59:59Z');
    const afterMidnight = new Date('2026-10-01T21:00:00Z');

    const first = await dailyCounterHit(redis, {
      prefix: counterPrefix,
      limit: 2,
      now: beforeMidnight,
    });
    expect(first).toMatchObject({ allowed: true, count: 1, day: '2026-10-01' });
    await dailyCounterHit(redis, { prefix: counterPrefix, limit: 2, now: beforeMidnight });
    const third = await dailyCounterHit(redis, {
      prefix: counterPrefix,
      limit: 2,
      now: beforeMidnight,
    });
    expect(third).toMatchObject({ allowed: false, count: 2 });
    expect(await dailyCounterGet(redis, { prefix: counterPrefix, now: beforeMidnight })).toBe(2);

    // A higher threshold (critical calls) still passes on the same day.
    const critical = await dailyCounterHit(redis, {
      prefix: counterPrefix,
      limit: 3,
      now: beforeMidnight,
    });
    expect(critical).toMatchObject({ allowed: true, count: 3 });

    const nextDay = await dailyCounterHit(redis, {
      prefix: counterPrefix,
      limit: 2,
      now: afterMidnight,
    });
    expect(nextDay).toMatchObject({ allowed: true, count: 1, day: '2026-10-02' });

    const ttl = await redis.ttl(first.key);
    expect(ttl).toBeGreaterThan(25 * 3600);
    expect(ttl).toBeLessThanOrEqual(26 * 3600);
  });
});
