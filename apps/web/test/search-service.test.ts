// search-service on the bundled Rossko fixtures: no network, no Redis, no database.
import { parseEnv } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import { applyMarkup, DEFAULT_EXCLUDED_RULES } from '@detaly/domain';
import {
  createFixtureCaller,
  createRosskoClient,
  createUnlimitedLimiter,
  FIXTURE_LOCAL_STOCK_IDS,
  QuotaBreakerError,
  RosskoRateLimitError,
  type RosskoClient,
} from '@detaly/rossko';
import { describe, expect, it, vi } from 'vitest';
import {
  createSearchService,
  normalizeSearchInput,
  SearchInputError,
  SearchUnavailableError,
  type SearchLogRow,
  type SearchServiceDeps,
} from '@/server/search-service';
import { resolveSearchSettings } from '@/server/settings';

const NOW = new Date('2026-10-02T06:00:00Z');
const env = parseEnv(minimalEnvSource());
const settings = resolveSearchSettings(new Map(), env, [...DEFAULT_EXCLUDED_RULES]);

function fixtureClient(): RosskoClient {
  return createRosskoClient({
    caller: createFixtureCaller(),
    key1: null,
    key2: null,
    localStockIds: FIXTURE_LOCAL_STOCK_IDS,
    limiter: createUnlimitedLimiter(),
    allowCheckout: false,
  });
}

function service(overrides: Partial<SearchServiceDeps> = {}) {
  const logged: SearchLogRow[] = [];
  const deps: SearchServiceDeps = {
    rossko: fixtureClient(),
    limiter: createUnlimitedLimiter(),
    loadSettings: () => Promise.resolve(settings),
    logSearch: (row) => {
      logged.push(row);
      return Promise.resolve();
    },
    now: () => NOW,
    ...overrides,
  };
  return { svc: createSearchService(deps), logged };
}

describe('normalizeSearchInput', () => {
  it('normalizes the article and trims the brand', () => {
    expect(normalizeSearchInput({ q: '  w 914/2 ', brand: ' MANN ', localOnly: true })).toEqual({
      query: 'w 914/2',
      articleNorm: 'W9142',
      brand: 'MANN',
      localOnly: true,
    });
  });

  it.each([
    [null, 'missing'],
    ['   ', 'missing'],
    ['ab', 'too_short'],
    ['a-b/', 'too_short'],
    ['x'.repeat(65), 'too_long'],
  ])('rejects %j with %s', (q, code) => {
    try {
      normalizeSearchInput({ q });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SearchInputError);
      expect((error as SearchInputError).code).toBe(code);
    }
  });
});

describe('searchOffers on fixtures', () => {
  it('prices every offer at ceil(supplier x 1.28) and marks Orenburg stocks', async () => {
    const supplier = await fixtureClient().search('OC90');
    const { svc } = service();
    const result = await svc.search({ q: 'OC 90' });

    expect(result.articleNorm).toBe('OC90');
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.length).toBe(result.totalBeforeFilters);
    for (const view of result.offers) {
      const source = supplier.offers.find(
        (offer) =>
          offer.articleNorm === view.articleNorm &&
          offer.brand === view.brand &&
          offer.stock.stockId === view.stockId,
      );
      expect(source, view.id).toBeDefined();
      expect(view.priceClientKop).toBe(applyMarkup(source!.priceSupplierKop, 2800));
      expect(view.priceClientKop % 100).toBe(0);
      expect(view.isLocal).toBe(FIXTURE_LOCAL_STOCK_IDS.includes(view.stockId));
      expect(view.promiseText).toMatch(/^к (пн|вт|ср|чт|пт|сб|вс) \d{1,2} [а-я]+$/);
      // Never leaks supplier price or markup.
      expect(Object.keys(view)).not.toContain('priceSupplierKop');
      expect(Object.keys(view)).not.toContain('markupBp');
    }
    expect(result.offers.some((offer) => offer.isLocal)).toBe(true);
    expect(result.offers.some((offer) => !offer.isLocal)).toBe(true);
    // The requested article comes before crosses.
    const firstCross = result.offers.findIndex((offer) => offer.isCross);
    expect(result.offers.slice(firstCross).every((offer) => offer.isCross)).toBe(true);
  });

  it('filters by local stock and brand', async () => {
    const { svc } = service();
    const local = await svc.search({ q: 'OC90', localOnly: true });
    expect(local.offers.length).toBeGreaterThan(0);
    expect(local.offers.every((offer) => offer.isLocal)).toBe(true);
    expect(local.totalBeforeFilters).toBeGreaterThan(local.offers.length);

    const all = await svc.search({ q: 'GDB1330' });
    expect(all.brands.length).toBeGreaterThan(1);
    const brand = all.brands[1] as string;
    const one = await svc.search({ q: 'GDB1330', brand: brand.toLowerCase() });
    expect(one.offers.length).toBeGreaterThan(0);
    expect(one.offers.every((offer) => offer.brand === brand)).toBe(true);
  });

  it('marks marked goods (oil) as excluded via excluded rules', async () => {
    const { svc } = service();
    const result = await svc.search({ q: 'EDGE5W40' });
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.every((offer) => offer.excluded)).toBe(true);
    expect(result.offers[0]?.excludedReason).toMatch(/масла/);
  });

  it('accepts a single object instead of an array (W9142)', async () => {
    const { svc } = service();
    const result = await svc.search({ q: 'W 914/2' });
    expect(result.offers).toHaveLength(1);
  });

  it('returns an empty result for unknown articles', async () => {
    const { svc } = service();
    const result = await svc.search({ q: 'NOSUCHPART1' });
    expect(result.offers).toEqual([]);
    expect(result.totalBeforeFilters).toBe(0);
  });

  it('writes search_log fire-and-forget without the client ip', async () => {
    const { svc, logged } = service();
    const result = await svc.search({ q: 'oc90', brand: 'Knecht' });
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toEqual({
      query: 'oc90',
      brand: 'Knecht',
      article: 'OC90',
      resultsCount: result.offers.length,
      fromCache: false,
      latencyMs: expect.any(Number),
    });
  });

  it('a failing search_log write does not fail the search', async () => {
    const onBackgroundError = vi.fn();
    const { svc } = service({
      logSearch: () => Promise.reject(new Error('db down')),
      onBackgroundError,
    });
    await expect(svc.search({ q: 'OC90' })).resolves.toMatchObject({ articleNorm: 'OC90' });
    await vi.waitFor(() =>
      expect(onBackgroundError).toHaveBeenCalledWith(expect.any(Error), 'search_log'),
    );
  });

  it('maps the quota breaker to 503 "quota"', async () => {
    const { svc } = service({
      rossko: { search: () => Promise.reject(new QuotaBreakerError()) },
    });
    await expect(svc.search({ q: 'OC90' })).rejects.toMatchObject({
      name: 'SearchUnavailableError',
      reason: 'quota',
    });
  });

  it('maps the per-minute limit to 503 "rate" with Retry-After', async () => {
    const { svc } = service({
      rossko: { search: () => Promise.reject(new RosskoRateLimitError(1500)) },
    });
    const error = await svc.search({ q: 'OC90' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchUnavailableError);
    expect(error).toMatchObject({ reason: 'rate', retryAfterSec: 2 });
  });

  it('maps any other failure (Redis or supplier down) to 503 "supplier"', async () => {
    const onBackgroundError = vi.fn();
    const { svc } = service({
      rossko: { search: () => Promise.reject(new Error('connect ECONNREFUSED')) },
      onBackgroundError,
    });
    await expect(svc.search({ q: 'OC90' })).rejects.toMatchObject({ reason: 'supplier' });
    expect(onBackgroundError).toHaveBeenCalledWith(expect.any(Error), 'rossko search');
  });

  it('reports quota state and survives a limiter status failure', async () => {
    const ok = await service().svc.search({ q: 'OC90' });
    expect(ok.quota).toEqual({ breakerOpen: false, exhausted: false });

    const broken = await service({
      limiter: { status: () => Promise.reject(new Error('redis down')) },
    }).svc.search({ q: 'OC90' });
    expect(broken.quota).toBeNull();
  });
});
