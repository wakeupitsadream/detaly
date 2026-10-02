import { describe, expect, it } from 'vitest';
import { createFixtureCaller, FIXTURE_LOCAL_STOCK_IDS } from './fixture-caller';
import { createRosskoClient } from './client';
import { QuotaBreakerError, RosskoRateLimitError } from './errors';
import { createMemoryLimiter, createMemorySearchCache } from './memory';

function fakeClock(start: number) {
  const clock = { now: start, slept: [] as number[] };
  return {
    clock,
    now: () => clock.now,
    sleep: (ms: number) => {
      clock.slept.push(ms);
      clock.now += ms;
      return Promise.resolve();
    },
  };
}

describe('createMemorySearchCache', () => {
  const value = { offers: [], message: null, fetchedAt: '2026-10-02T10:00:00.000Z' };

  it('uses the Redis key layout and expires entries', async () => {
    const { clock, now } = fakeClock(1_000_000);
    const cache = createMemorySearchCache({ ttlSec: 900, keyPrefix: 'fx:', now });
    const key = cache.key('OC90', null);
    expect(key).toBe('fx:rossko:search:v2:OC90:-');
    expect(await cache.get(key)).toBeNull();
    await cache.set(key, value);
    expect(await cache.get(key)).toEqual(value);
    clock.now += 899_000;
    expect(await cache.get(key)).toEqual(value);
    clock.now += 1_000;
    expect(await cache.get(key)).toBeNull();
    await cache.set(key, value, 60);
    clock.now += 60_000;
    expect(await cache.get(key)).toBeNull();
  });

  it('returns copies and evicts the oldest entry beyond the cap', async () => {
    const cache = createMemorySearchCache({ maxEntries: 2 });
    await cache.set('a', value);
    await cache.set('b', value);
    const hit = await cache.get('a');
    hit?.offers.push({} as never);
    expect((await cache.get('a'))?.offers).toEqual([]);
    await cache.set('c', value);
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).not.toBeNull();
    expect(await cache.get('c')).not.toBeNull();
  });
});

describe('createMemoryLimiter', () => {
  it('waits for the sliding minute and fails past maxWaitMs', async () => {
    const { clock, now, sleep } = fakeClock(Date.UTC(2026, 9, 2, 9, 0, 0));
    const limiter = createMemoryLimiter({ rpm: 2, daily: 100, breakerPct: 70, now, sleep });
    await limiter.acquire({ priority: 'search' });
    clock.now += 10_000;
    await limiter.acquire({ priority: 'search' });
    const third = await limiter.acquire({ priority: 'search', maxWaitMs: 60_000 });
    expect(third.waitedMs).toBe(50_000);
    expect(clock.slept).toEqual([50_000]);
    await expect(limiter.acquire({ priority: 'search', maxWaitMs: 1_000 })).rejects.toBeInstanceOf(
      RosskoRateLimitError,
    );
    expect((await limiter.tryAcquire({ priority: 'search' })).allowed).toBe(false);
  });

  it('opens the breaker for searches and exhausts the day for critical calls', async () => {
    const { clock, now, sleep } = fakeClock(Date.UTC(2026, 9, 2, 9, 0, 0));
    const limiter = createMemoryLimiter({ rpm: 100, daily: 10, breakerPct: 70, now, sleep });
    for (let i = 0; i < 7; i += 1) await limiter.acquire({ priority: 'search' });
    await expect(limiter.acquire({ priority: 'search' })).rejects.toMatchObject({
      name: 'QuotaBreakerError',
      reason: 'breaker',
    });
    expect(await limiter.status()).toMatchObject({ dailyCount: 7, breakerOpen: true });
    for (let i = 0; i < 3; i += 1) await limiter.acquire({ priority: 'critical' });
    const error: unknown = await limiter.acquire({ priority: 'critical' }).catch((e) => e);
    expect(error).toBeInstanceOf(QuotaBreakerError);
    expect((error as QuotaBreakerError).reason).toBe('exhausted');
    // The next Moscow day starts a new count (21:00 UTC = midnight in Moscow).
    clock.now = Date.UTC(2026, 9, 2, 21, 0, 1);
    expect(await limiter.status()).toMatchObject({ day: '2026-10-03', dailyCount: 0 });
    await limiter.acquire({ priority: 'search' });
  });

  it('validates its options', () => {
    expect(() => createMemoryLimiter({ rpm: 0, daily: 1, breakerPct: 70 })).toThrow(RangeError);
    expect(() => createMemoryLimiter({ rpm: 1, daily: 1, breakerPct: 0 })).toThrow(RangeError);
  });
});

describe('client on memory cache and limiter', () => {
  it('serves the second search from the cache', async () => {
    const limiter = createMemoryLimiter({ rpm: 10, daily: 100, breakerPct: 70 });
    const client = createRosskoClient({
      caller: createFixtureCaller(),
      key1: null,
      key2: null,
      localStockIds: FIXTURE_LOCAL_STOCK_IDS,
      limiter,
      cache: createMemorySearchCache({ keyPrefix: 'fx:' }),
      allowCheckout: false,
    });
    const first = await client.search('OC90');
    expect(first.fromCache).toBe(false);
    expect(first.offers.length).toBeGreaterThan(0);
    const second = await client.search('OC90');
    expect(second.fromCache).toBe(true);
    expect(second.offers).toEqual(first.offers);
    expect((await limiter.status()).dailyCount).toBe(1);
  });
});
