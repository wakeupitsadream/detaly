/**
 * Limiter against the real Redis from scripts/dev-db.sh (keys under test:<uuid>:, no FLUSHDB).
 */
import { createRedis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuotaBreakerError, RosskoRateLimitError } from '../src/errors';
import { createRosskoLimiter, type RosskoLimiterOptions } from '../src/limiter';

let redis: Redis;
const prefix = testKeyPrefix();
let caseNo = 0;

beforeAll(() => {
  redis = createRedis(testRedisUrl());
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
});

/** Limiter with a fake clock; `sleep` advances the clock instead of waiting. */
function setup(start: number, options: Partial<RosskoLimiterOptions> = {}) {
  caseNo += 1;
  const keyPrefix = `${prefix}${caseNo}:`;
  const clock = { now: start, slept: [] as number[] };
  const limiter = createRosskoLimiter(redis, {
    rpm: 250,
    daily: 90_000,
    breakerPct: 70,
    keyPrefix,
    now: () => clock.now,
    sleep: (ms) => {
      clock.slept.push(ms);
      clock.now += ms;
      return Promise.resolve();
    },
    ...options,
  });
  return { limiter, clock, keyPrefix };
}

const T0 = Date.parse('2026-10-02T09:00:00Z');

describe('createRosskoLimiter: per-minute sliding window', () => {
  it('lets 250 calls through; the 251st waits 60000 - Δ and passes after the clock moves 60001 ms', async () => {
    const { limiter, clock, keyPrefix } = setup(T0);
    for (let i = 0; i < 250; i += 1) {
      clock.now = T0 + i * 10;
      const hit = await limiter.tryAcquire({ priority: 'search' });
      expect(hit).toEqual({ allowed: true, dailyCount: i + 1 });
    }
    const delta = 3_000;
    clock.now = T0 + delta;
    expect(await limiter.tryAcquire({ priority: 'critical' })).toEqual({
      allowed: false,
      reason: 'rate',
      waitMs: 60_000 - delta,
      dailyCount: 250,
    });

    // acquire gives up when the wait exceeds maxWaitMs; nothing is recorded.
    const error = (await limiter
      .acquire({ priority: 'search', maxWaitMs: 1_000 })
      .catch((e: unknown) => e)) as RosskoRateLimitError;
    expect(error).toBeInstanceOf(RosskoRateLimitError);
    expect(error.retryAfterMs).toBe(60_000 - delta);
    expect(await redis.zcard(`${keyPrefix}rossko:rpm`)).toBe(250);

    clock.now = T0 + delta + 60_001;
    expect(await limiter.tryAcquire({ priority: 'search' })).toEqual({
      allowed: true,
      dailyCount: 251,
    });
  });

  it('acquire sleeps until the oldest call leaves the window', async () => {
    const { limiter, clock } = setup(T0);
    for (let i = 0; i < 250; i += 1) await limiter.tryAcquire({ priority: 'search' });
    clock.now = T0 + 1_000;
    const result = await limiter.acquire({ priority: 'search', maxWaitMs: 60_000 });
    expect(clock.slept).toEqual([59_000]);
    expect(result).toEqual({ waitedMs: 59_000, dailyCount: 251 });
  });

  it('a smaller rpm is honoured (window key expires with the window)', async () => {
    const { limiter, keyPrefix } = setup(T0, { rpm: 3 });
    for (let i = 0; i < 3; i += 1)
      expect((await limiter.tryAcquire({ priority: 'search' })).allowed).toBe(true);
    expect(await limiter.tryAcquire({ priority: 'search' })).toMatchObject({
      allowed: false,
      reason: 'rate',
    });
    const ttl = await redis.pttl(`${keyPrefix}rossko:rpm`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});

describe('createRosskoLimiter: daily quota and breaker', () => {
  it('stops searches at 70% while critical calls pass up to 100%; then everything stops', async () => {
    const { limiter, keyPrefix } = setup(T0, { daily: 10, breakerPct: 70, rpm: 1_000 });
    for (let i = 1; i <= 7; i += 1) {
      expect(await limiter.acquire({ priority: 'search' })).toEqual({ waitedMs: 0, dailyCount: i });
    }
    const breaker = (await limiter
      .acquire({ priority: 'search' })
      .catch((e: unknown) => e)) as QuotaBreakerError;
    expect(breaker).toBeInstanceOf(QuotaBreakerError);
    expect(breaker).toMatchObject({
      reason: 'breaker',
      priority: 'search',
      dailyCount: 7,
      limit: 7,
    });
    expect(await limiter.status()).toMatchObject({
      dailyCount: 7,
      dailyLimit: 10,
      breakerLimit: 7,
      breakerOpen: true,
      exhausted: false,
    });

    for (let i = 8; i <= 10; i += 1) {
      expect(await limiter.acquire({ priority: 'critical' })).toMatchObject({ dailyCount: i });
    }
    for (const priority of ['critical', 'search'] as const) {
      const error = (await limiter
        .acquire({ priority })
        .catch((e: unknown) => e)) as QuotaBreakerError;
      expect(error).toBeInstanceOf(QuotaBreakerError);
      expect(error).toMatchObject({ reason: 'exhausted', dailyCount: 10 });
    }
    // Rejected calls consume neither the day nor the window.
    expect(await redis.get(`${keyPrefix}rossko:quota:2026-10-02`)).toBe('10');
    expect(await redis.zcard(`${keyPrefix}rossko:rpm`)).toBe(10);
    expect(await limiter.status()).toMatchObject({ exhausted: true, breakerOpen: true });
  });

  it('90000 * 70% = 63000 searches (integer threshold)', async () => {
    const { limiter, keyPrefix } = setup(T0);
    await redis.set(`${keyPrefix}rossko:quota:2026-10-02`, '62999');
    expect(await limiter.tryAcquire({ priority: 'search' })).toEqual({
      allowed: true,
      dailyCount: 63_000,
    });
    expect(await limiter.tryAcquire({ priority: 'search' })).toMatchObject({
      allowed: false,
      reason: 'breaker',
    });
    expect(await limiter.tryAcquire({ priority: 'critical' })).toEqual({
      allowed: true,
      dailyCount: 63_001,
    });
  });

  it('switches the daily key at Moscow midnight (20:59:59Z vs 21:00:00Z), TTL 26 h', async () => {
    const { limiter, clock, keyPrefix } = setup(Date.parse('2026-10-01T20:59:59Z'), {
      daily: 3,
      breakerPct: 100,
      rpm: 1_000,
    });
    for (let i = 0; i < 3; i += 1) await limiter.acquire({ priority: 'critical' });
    await expect(limiter.acquire({ priority: 'critical' })).rejects.toBeInstanceOf(
      QuotaBreakerError,
    );
    expect(await limiter.status()).toMatchObject({ day: '2026-10-01', dailyCount: 3 });

    const ttl = await redis.ttl(`${keyPrefix}rossko:quota:2026-10-01`);
    expect(ttl).toBeGreaterThan(26 * 3600 - 10);
    expect(ttl).toBeLessThanOrEqual(26 * 3600);

    clock.now = Date.parse('2026-10-01T21:00:00Z');
    expect(await limiter.acquire({ priority: 'critical' })).toEqual({ waitedMs: 0, dailyCount: 1 });
    expect(await limiter.status()).toMatchObject({ day: '2026-10-02', dailyCount: 1 });
    expect(await redis.get(`${keyPrefix}rossko:quota:2026-10-02`)).toBe('1');
  });

  it('keeps the TTL when the day key already exists (does not extend it)', async () => {
    const { limiter, keyPrefix } = setup(T0);
    const key = `${keyPrefix}rossko:quota:2026-10-02`;
    await redis.set(key, '5', 'EX', 100);
    await limiter.tryAcquire({ priority: 'search' });
    expect(await redis.ttl(key)).toBeLessThanOrEqual(100);
    // A key without TTL (e.g. set by hand) gets one.
    await redis.persist(key);
    await limiter.tryAcquire({ priority: 'search' });
    expect(await redis.ttl(key)).toBeGreaterThan(26 * 3600 - 10);
  });
});

describe('createRosskoLimiter: options', () => {
  it('rejects invalid limits', () => {
    expect(() => createRosskoLimiter(redis, { rpm: 0, daily: 1, breakerPct: 70 })).toThrow(
      RangeError,
    );
    expect(() => createRosskoLimiter(redis, { rpm: 1, daily: 1.5, breakerPct: 70 })).toThrow(
      RangeError,
    );
    expect(() => createRosskoLimiter(redis, { rpm: 1, daily: 1, breakerPct: 101 })).toThrow(
      RangeError,
    );
  });
});
