/**
 * Search cache + client + limiter against the real Redis (keys under test:<uuid>:).
 */
import { createRedis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSearchCache, SEARCH_CACHE_TTL_SEC } from '../src/cache';
import { createRosskoClient } from '../src/client';
import { QuotaBreakerError } from '../src/errors';
import { createFixtureCaller } from '../src/fixture-caller';
import { createRosskoLimiter } from '../src/limiter';
import type { RosskoCaller, RosskoMethod } from '../src/types';

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

function setup(options: { delayMs?: number; daily?: number; breakerPct?: number } = {}) {
  caseNo += 1;
  const keyPrefix = `${prefix}${caseNo}:`;
  const fixtures = createFixtureCaller();
  const calls: { method: RosskoMethod; text: unknown }[] = [];
  const caller: RosskoCaller = {
    async call(method, args) {
      calls.push({ method, text: args.text });
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      return fixtures.call(method, args);
    },
  };
  const limiter = createRosskoLimiter(redis, {
    rpm: 250,
    daily: options.daily ?? 90_000,
    breakerPct: options.breakerPct ?? 70,
    keyPrefix,
  });
  const client = createRosskoClient({
    caller,
    key1: 'k1',
    key2: 'k2',
    deliveryId: '000000001',
    localStockIds: ['ORB1'],
    limiter,
    cache: createSearchCache(redis, { keyPrefix }),
    allowCheckout: false,
  });
  return { client, calls, limiter, keyPrefix };
}

describe('search cache', () => {
  it('serves a repeated query from Redis for 900 s under rossko:search:v2:<norm>:<deliveryId>', async () => {
    const { client, calls, keyPrefix } = setup();
    const first = await client.search('OC90');
    const second = await client.search('oc 90');
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.offers).toEqual(first.offers);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(calls).toHaveLength(1);

    const key = `${keyPrefix}rossko:search:v2:OC90:000000001`;
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(SEARCH_CACHE_TTL_SEC - 10);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it('bypassCache goes to the supplier and refreshes the cached value', async () => {
    const { client, calls, keyPrefix } = setup();
    await client.search('W9142');
    const key = `${keyPrefix}rossko:search:v2:W9142:000000001`;
    await redis.set(
      key,
      JSON.stringify({ offers: [], message: 'stale', fetchedAt: '2000-01-01T00:00:00.000Z' }),
      'EX',
      900,
    );
    expect(await client.search('W9142')).toMatchObject({
      fromCache: true,
      message: 'stale',
      offers: [],
    });

    const fresh = await client.search('W9142', { bypassCache: true, priority: 'critical' });
    expect(fresh.fromCache).toBe(false);
    expect(fresh.offers).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(await client.search('W9142')).toMatchObject({ fromCache: true });
    expect((await client.search('W9142')).offers).toHaveLength(1);
  });

  it('caches empty answers (nothing found) too', async () => {
    const { client, calls } = setup();
    const first = await client.search('NOTFOUND');
    const second = await client.search('NOTFOUND');
    expect(first).toMatchObject({ offers: [], fromCache: false, message: 'Ничего не найдено' });
    expect(second).toMatchObject({ offers: [], fromCache: true, message: 'Ничего не найдено' });
    expect(calls).toHaveLength(1);
  });

  it('single-flight: identical concurrent searches make one supplier call and one quota hit', async () => {
    const { client, calls, limiter } = setup({ delayMs: 50 });
    const results = await Promise.all(
      ['GDB1330', 'gdb 1330', 'GDB-1330', 'GDB1330', 'gdb1330'].map((q) => client.search(q)),
    );
    expect(calls).toHaveLength(1);
    expect(new Set(results.map((r) => JSON.stringify(r.offers))).size).toBe(1);
    expect(results.every((r) => r.offers.length === 3)).toBe(true);
    expect((await limiter.status()).dailyCount).toBe(1);

    // after the flight lands, the next one is a cache hit
    expect((await client.search('GDB1330')).fromCache).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('with the breaker open, cached queries still answer and uncached ones fail', async () => {
    const { client, calls } = setup({ daily: 2, breakerPct: 50 });
    await client.search('OC90'); // 1 of 2: breaker threshold is 1 search
    await expect(client.search('W9142')).rejects.toBeInstanceOf(QuotaBreakerError);
    expect((await client.search('OC90')).fromCache).toBe(true);
    // a critical recheck still reaches the supplier
    expect(
      (await client.search('W9142', { priority: 'critical', bypassCache: true })).offers,
    ).toHaveLength(1);
    expect(calls.map((c) => c.text)).toEqual(['OC90', 'W9142']);
  });

  it('ignores a corrupted cache entry', async () => {
    const { client, calls, keyPrefix } = setup();
    await redis.set(`${keyPrefix}rossko:search:v2:OC90:000000001`, '{not json', 'EX', 900);
    expect((await client.search('OC90')).fromCache).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
