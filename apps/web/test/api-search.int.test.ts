// GET /api/search handler with the real wiring (fixtures caller, Redis limiter and cache,
// settings and search_log in Postgres) against local PG/Redis; keys under test:<uuid>:.
import { createRedis, mskDayKey, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { createDb, type Db } from '@detaly/db';
import type { OfferView } from '@detaly/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleSearchRequest } from '@/server/api/search-handler';
import { rosskoKeyPrefix } from '@/server/rossko';
import { createSearchDeps } from '@/server/search';
import { createSearchService, type SearchService } from '@/server/search-service';
import { intEnv, webDatabaseUrl } from './helpers';

const prefix = testKeyPrefix();
let redis: Redis;
let db: Db;
let service: SearchService;
const errors: string[] = [];

function get(path: string): Promise<Response> {
  return handleSearchRequest(new URL(path, 'http://localhost'), service);
}

async function searchLogCount(article: string): Promise<number> {
  const rows = await db.$client<{ count: string }[]>`
    select count(*)::text as count from search_log where article = ${article}`;
  return Number(rows[0]?.count ?? 0);
}

beforeAll(() => {
  redis = createRedis(testRedisUrl());
  db = createDb(webDatabaseUrl(), { max: 3 });
  service = createSearchService(
    createSearchDeps({
      env: intEnv(),
      db,
      redis,
      keyPrefix: prefix,
      onError: (error, what) => errors.push(`${what}: ${String(error)}`),
    }),
  );
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
  await db.close();
});

describe('GET /api/search', () => {
  it('returns offers with client prices from the seeded markup, then serves from cache', async () => {
    const before = await searchLogCount('OC90');
    const first = await get('/api/search?q=oc%2090');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const body = (await first.json()) as {
      offers: OfferView[];
      fromCache: boolean;
      quota: unknown;
      articleNorm: string;
    };
    expect(body.articleNorm).toBe('OC90');
    expect(body.fromCache).toBe(false);
    expect(body.quota).toEqual({ breakerOpen: false, exhausted: false });
    expect(body.offers.length).toBeGreaterThan(0);
    expect(body.offers.some((offer) => offer.isLocal)).toBe(true);
    for (const offer of body.offers) {
      expect(offer.priceClientKop % 100).toBe(0);
      expect(offer).not.toHaveProperty('priceSupplierKop');
    }

    const second = await get('/api/search?q=OC90');
    expect(((await second.json()) as { fromCache: boolean }).fromCache).toBe(true);

    await vi.waitFor(async () => expect(await searchLogCount('OC90')).toBe(before + 2));
    const [row] = await db.$client<{ from_cache: boolean; results_count: number }[]>`
      select from_cache, results_count from search_log
      where article = 'OC90' order by created_at desc limit 1`;
    expect(row).toEqual({ from_cache: true, results_count: body.offers.length });
    expect(errors).toEqual([]);
  });

  it('filters by local=1 and brand', async () => {
    const response = await get('/api/search?q=OC90&local=1');
    const body = (await response.json()) as { offers: OfferView[]; total: number };
    expect(body.offers.length).toBeGreaterThan(0);
    expect(body.offers.every((offer) => offer.isLocal)).toBe(true);
    expect(body.total).toBeGreaterThan(body.offers.length);

    const branded = (await (await get('/api/search?q=OC90&brand=knecht')).json()) as {
      offers: OfferView[];
    };
    expect(branded.offers.length).toBeGreaterThan(0);
    expect(branded.offers.every((offer) => offer.brand.toLowerCase() === 'knecht')).toBe(true);
  });

  it('flags marked goods from excluded_groups in the database', async () => {
    const body = (await (await get('/api/search?q=EDGE5W40')).json()) as { offers: OfferView[] };
    expect(body.offers.length).toBeGreaterThan(0);
    expect(body.offers.every((offer) => offer.excluded)).toBe(true);
  });

  it('answers 400 for queries shorter than 3 characters after normalization', async () => {
    for (const path of [
      '/api/search',
      '/api/search?q=',
      '/api/search?q=a-b',
      '/api/search?q=%20O%2FC',
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.any(String),
        message: expect.any(String),
      });
    }
  });

  it('answers 503 when the quota breaker is open and the cache is empty, cached articles still work', async () => {
    // Open the breaker: 70% of ROSSKO_DAILY_LIMIT already used today (Moscow day).
    const fx = rosskoKeyPrefix('fixtures', prefix);
    await redis.set(`${fx}rossko:quota:${mskDayKey(new Date())}`, String(63_000), 'EX', 600);

    const uncached = await get('/api/search?q=GDB1330');
    expect(uncached.status).toBe(503);
    expect(await uncached.json()).toMatchObject({ error: 'unavailable', reason: 'quota' });

    const cached = await get('/api/search?q=OC90');
    expect(cached.status).toBe(200);
    expect(await cached.json()).toMatchObject({
      fromCache: true,
      quota: { breakerOpen: true, exhausted: false },
    });
  });
});

describe('fixtures and live never share Redis keys', () => {
  it('fixture searches use the fx: limiter and cache, the live quota and cache stay untouched', async () => {
    expect(rosskoKeyPrefix('live', prefix)).toBe(prefix);
    expect(rosskoKeyPrefix('fixtures', prefix)).toBe(`${prefix}fx:`);
    const live = await redis.keys(`${prefix}rossko:*`);
    expect(live).toEqual([]);
    const fixtures = await redis.keys(`${prefix}fx:rossko:*`);
    expect(fixtures.some((key) => key.includes('rossko:search:'))).toBe(true);
    expect(fixtures.some((key) => key.includes('rossko:quota:'))).toBe(true);
  });
});

describe('search with Redis down', () => {
  it('answers 503: Rossko is never called without its limiter', async () => {
    const deadRedis = createRedis('redis://127.0.0.1:1/0', {
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
      retryStrategy: () => 200,
    });
    deadRedis.on('error', () => {});
    try {
      const deadService = createSearchService(
        createSearchDeps({ env: intEnv(), db, redis: deadRedis, keyPrefix: prefix }),
      );
      const response = await handleSearchRequest(
        new URL('/api/search?q=W9142', 'http://localhost'),
        deadService,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ reason: 'supplier' });
    } finally {
      deadRedis.disconnect();
    }
  });
});
