import { describe, expect, it, vi } from 'vitest';
import { SEARCH_ERROR_CACHE_TTL_SEC, type CachedSearch, type SearchCache } from './cache';
import {
  createRosskoClient,
  createRosskoCaller,
  searchFailure,
  type RosskoClientOptions,
} from './client';
import {
  CheckoutDisabledError,
  checkoutMayHaveExecuted,
  QuotaBreakerError,
  RosskoCallError,
  RosskoConfigError,
  RosskoRateLimitError,
  SearchCacheMissError,
} from './errors';
import { RosskoResponseError } from './mapper';
import { createFixtureCaller } from './fixture-caller';
import { createUnlimitedLimiter } from './limiter';
import type { RosskoCallEvent, RosskoCaller, RosskoLimiter } from './types';

const KEY1 = 'key-one-0000';
const KEY2 = 'key-two-0000';

function spyCaller(inner: RosskoCaller = createFixtureCaller()) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const caller: RosskoCaller = {
    async call(method, args) {
      calls.push({ method, args });
      return inner.call(method, args);
    },
  };
  return { caller, calls };
}

function memoryCache(): SearchCache & {
  store: Map<string, CachedSearch>;
  ttls: Map<string, number | undefined>;
} {
  const store = new Map<string, CachedSearch>();
  const ttls = new Map<string, number | undefined>();
  return {
    store,
    key: (norm, deliveryId) => `rossko:search:v2:${norm}:${deliveryId ?? '-'}`,
    get: (key) => Promise.resolve(store.get(key) ?? null),
    set: (key, value, ttlSec) => {
      store.set(key, structuredClone(value));
      ttls.set(key, ttlSec);
      return Promise.resolve();
    },
    ttls,
  };
}

function client(overrides: Partial<RosskoClientOptions> = {}) {
  const { caller, calls } = spyCaller();
  const events: RosskoCallEvent[] = [];
  const instance = createRosskoClient({
    caller,
    key1: KEY1,
    key2: KEY2,
    deliveryId: '000000001',
    addressId: '1001',
    paymentId: '1',
    localStockIds: ['ORB1'],
    limiter: createUnlimitedLimiter(),
    onCall: (e) => {
      events.push(e);
    },
    allowCheckout: true,
    ...overrides,
  });
  return { instance, calls, events };
}

describe('createRosskoClient.search', () => {
  it('sends normalized text with credentials and delivery ids, maps offers', async () => {
    const { instance, calls, events } = client();
    const result = await instance.search(' oc-90 ');
    expect(calls).toEqual([
      {
        method: 'GetSearch',
        args: { KEY1, KEY2, text: 'OC90', delivery_id: '000000001', address_id: '1001' },
      },
    ]);
    expect(result.fromCache).toBe(false);
    expect(result.offers).toHaveLength(5);
    expect(result.offers.filter((o) => o.stock.isLocal)).toHaveLength(2);
    expect(Date.parse(result.fetchedAt)).not.toBeNaN();
    expect(events).toEqual([
      {
        source: 'rossko',
        method: 'GetSearch',
        priority: 'search',
        durationMs: expect.any(Number) as unknown,
        ok: true,
        supplierSuccess: true,
        error: null,
        timeout: false,
      },
    ]);
  });

  it('omits empty delivery/address ids', async () => {
    const { instance, calls } = client({ deliveryId: '', addressId: null });
    await instance.search('W9142');
    expect(calls[0]?.args).toEqual({ KEY1, KEY2, text: 'W9142' });
  });

  it('returns nothing without calling the supplier for an empty normalized query', async () => {
    const { instance, calls } = client();
    expect((await instance.search(' / - ')).offers).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('reads localStockIds from a function on every call (settings may change)', async () => {
    let ids: string[] = [];
    const { instance } = client({
      localStockIds: () => Promise.resolve(ids),
      cache: memoryCache(),
    });
    expect((await instance.search('OC90')).offers.some((o) => o.stock.isLocal)).toBe(false);
    ids = ['MSK7'];
    const cached = await instance.search('OC90');
    expect(cached.fromCache).toBe(true);
    expect(cached.offers.filter((o) => o.stock.isLocal).map((o) => o.brand)).toEqual([
      'Knecht',
      'BOSCH',
    ]);
  });

  it('reports NOTFOUND as success:false with the supplier message', async () => {
    const { instance, events } = client();
    const result = await instance.search('NOTFOUND');
    expect(result).toMatchObject({ offers: [], message: 'Ничего не найдено' });
    expect(events[0]).toMatchObject({ ok: true, supplierSuccess: false, error: null });
  });

  it('a success:false supplier error is reported ok=false and cached only briefly', async () => {
    const cache = memoryCache();
    const errorCaller: RosskoCaller = {
      call: () =>
        Promise.resolve({
          SearchResult: { success: false, message: `Неверный ключ ${KEY1}` },
        }),
    };
    const { instance, events } = client({ caller: errorCaller, cache });
    const result = await instance.search('OC90');
    expect(result).toMatchObject({ offers: [], fromCache: false });
    expect(events[0]).toMatchObject({
      ok: false,
      supplierSuccess: false,
      error: 'GetSearch success=false: Неверный ключ ***',
    });
    expect([...cache.ttls.values()]).toEqual([SEARCH_ERROR_CACHE_TTL_SEC]);

    // "nothing found" keeps the full TTL
    const notFound = memoryCache();
    await client({ cache: notFound }).instance.search('NOTFOUND');
    expect([...notFound.ttls.values()]).toEqual([undefined]);
  });

  it('searchFailure tells "nothing found" from supplier errors', () => {
    expect(searchFailure({ success: true, message: null })).toBeNull();
    expect(searchFailure({ success: false, message: 'Ничего не найдено' })).toBeNull();
    expect(searchFailure({ success: false, message: 'Товар не найден' })).toBeNull();
    expect(searchFailure({ success: false, message: null })).toMatch(/no message/);
    expect(searchFailure({ success: false, message: 'Ошибка авторизации' })).toMatch(
      /Ошибка авторизации/,
    );
  });

  it('propagates limiter errors without calling the supplier or the hook', async () => {
    const limiter: RosskoLimiter = {
      ...createUnlimitedLimiter(),
      acquire: () => Promise.reject(new QuotaBreakerError()),
    };
    const { instance, calls, events } = client({ limiter });
    await expect(instance.search('OC90')).rejects.toBeInstanceOf(QuotaBreakerError);
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('passes priority and the per-priority max wait to the limiter', async () => {
    const acquire = vi.fn(() => Promise.resolve({ waitedMs: 0, dailyCount: 1 }));
    const { instance } = client({
      limiter: { ...createUnlimitedLimiter(), acquire },
      searchMaxWaitMs: 111,
      criticalMaxWaitMs: 222,
    });
    await instance.search('OC90');
    await instance.search('OC90', { priority: 'critical' });
    expect(acquire.mock.calls).toEqual([
      [{ priority: 'search', maxWaitMs: 111 }],
      [{ priority: 'critical', maxWaitMs: 222 }],
    ]);
  });

  it('reports transport errors to the hook with masked text and rethrows', async () => {
    const failing: RosskoCaller = {
      call: () =>
        Promise.reject(new RosskoCallError('GetSearch', `timeout, key ${KEY1}`, { timeout: true })),
    };
    const { instance, events } = client({ caller: failing });
    await expect(instance.search('OC90')).rejects.toBeInstanceOf(RosskoCallError);
    expect(events[0]).toMatchObject({ ok: false, timeout: true, supplierSuccess: null });
    expect(events[0]?.error).not.toContain(KEY1);
  });

  it('survives a throwing or rejecting onCall hook', async () => {
    const sync = client({
      onCall: () => {
        throw new Error('db down');
      },
    });
    await expect(sync.instance.search('OC90')).resolves.toMatchObject({ fromCache: false });
    const async = client({ onCall: () => Promise.reject(new Error('db down')) });
    await expect(async.instance.search('OC90')).resolves.toMatchObject({ fromCache: false });
  });

  it('still answers when the cache read or write fails', async () => {
    const broken: SearchCache = {
      key: (n) => n,
      get: () => Promise.reject(new Error('redis down')),
      set: () => Promise.reject(new Error('redis down')),
    };
    const { instance, calls } = client({ cache: broken });
    await expect(instance.search('OC90')).resolves.toMatchObject({ fromCache: false });
    expect(calls).toHaveLength(1);
  });

  it('cacheOnly never calls the supplier: a miss throws SearchCacheMissError', async () => {
    const cache = memoryCache();
    const { instance, calls } = client({ cache });
    await expect(instance.search('OC90', { cacheOnly: true })).rejects.toBeInstanceOf(
      SearchCacheMissError,
    );
    expect(calls).toHaveLength(0);
    await instance.search('OC90');
    expect(calls).toHaveLength(1);
    await expect(instance.search('OC90', { cacheOnly: true })).resolves.toMatchObject({
      fromCache: true,
    });
    expect(calls).toHaveLength(1);
    // Without a cache, or with a broken one, there is nothing to read.
    const bare = client();
    await expect(bare.instance.search('OC90', { cacheOnly: true })).rejects.toThrow('cache miss');
    const broken: SearchCache = {
      key: (n) => n,
      get: () => Promise.reject(new Error('redis down')),
      set: () => Promise.resolve(),
    };
    const down = client({ cache: broken });
    await expect(down.instance.search('OC90', { cacheOnly: true })).rejects.toBeInstanceOf(
      SearchCacheMissError,
    );
    expect(bare.calls.length + down.calls.length).toBe(0);
  });
});

describe('createRosskoClient.checkout', () => {
  const request = {
    items: [{ brand: 'Knecht', article: 'OC 90', stockId: 'ORB1', count: 2, comment: 'DT-000001' }],
    contact: { name: 'Продавец', phone: '+79990000000' },
    comment: 'DT-000001',
  };

  it('throws CheckoutDisabledError when allowCheckout=false, before any call', async () => {
    const acquire = vi.fn(() => Promise.resolve({ waitedMs: 0, dailyCount: 1 }));
    const { instance, calls } = client({
      allowCheckout: false,
      limiter: { ...createUnlimitedLimiter(), acquire },
    });
    await expect(instance.checkout(request)).rejects.toBeInstanceOf(CheckoutDisabledError);
    expect(calls).toHaveLength(0);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('builds GetCheckout args and maps the result', async () => {
    const { instance, calls, events } = client();
    const result = await instance.checkout(request);
    expect(calls[0]).toEqual({
      method: 'GetCheckout',
      args: {
        KEY1,
        KEY2,
        delivery: { delivery_id: '000000001', address_id: '1001' },
        payment: { payment_id: '1' },
        delivery_parts: false,
        PARTS: {
          Part: [
            { partnumber: 'OC 90', brand: 'Knecht', stock: 'ORB1', count: 2, comment: 'DT-000001' },
          ],
        },
        contact: { name: 'Продавец', phone: '+79990000000' },
        comment: 'DT-000001',
      },
    });
    expect(result.orderIds).toEqual(['70000001']);
    expect(events[0]).toMatchObject({ method: 'GetCheckout', priority: 'critical', ok: true });
  });

  it('returns item errors from the itemErrors variant', async () => {
    const { instance } = client({ caller: createFixtureCaller({ checkoutVariant: 'itemErrors' }) });
    const result = await instance.checkout(request);
    expect(result.itemErrors).toHaveLength(1);
  });

  it('rejects empty orders, bad counts and items without a stock', async () => {
    const { instance, calls } = client();
    await expect(instance.checkout({ items: [] })).rejects.toThrow(RangeError);
    await expect(
      instance.checkout({ items: [{ brand: 'B', article: 'A', stockId: 'S', count: 1.5 }] }),
    ).rejects.toThrow(RangeError);
    await expect(
      instance.checkout({ items: [{ brand: 'B', article: 'A', stockId: ' ', count: 1 }] }),
    ).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['delivery id', { deliveryId: null }],
    ['payment id', { paymentId: '' }],
  ])('refuses to order without a %s, before the limiter', async (_label, overrides) => {
    const acquire = vi.fn(() => Promise.resolve({ waitedMs: 0, dailyCount: 1 }));
    const { instance, calls } = client({
      ...overrides,
      limiter: { ...createUnlimitedLimiter(), acquire },
    });
    await expect(instance.checkout(request)).rejects.toBeInstanceOf(RosskoConfigError);
    expect(acquire).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe('checkoutMayHaveExecuted', () => {
  it('is false only for errors raised before the request left the process', () => {
    expect(checkoutMayHaveExecuted(new CheckoutDisabledError())).toBe(false);
    expect(checkoutMayHaveExecuted(new RosskoConfigError('x'))).toBe(false);
    expect(checkoutMayHaveExecuted(new QuotaBreakerError())).toBe(false);
    expect(checkoutMayHaveExecuted(new RosskoRateLimitError(1000))).toBe(false);
    expect(checkoutMayHaveExecuted(new RangeError('bad count'))).toBe(false);
    expect(checkoutMayHaveExecuted(new RosskoCallError('GetCheckout', 'x', { wsdl: true }))).toBe(
      false,
    );
  });

  it('is true for timeouts, resets after sending, SOAP faults and unparsable replies', () => {
    expect(
      checkoutMayHaveExecuted(new RosskoCallError('GetCheckout', 'x', { timeout: true })),
    ).toBe(true);
    expect(
      checkoutMayHaveExecuted(
        new RosskoCallError('GetCheckout', 'socket hang up', { code: 'ECONNRESET' }),
      ),
    ).toBe(true);
    expect(checkoutMayHaveExecuted(new RosskoResponseError('GetCheckout', 'shape'))).toBe(true);
    expect(checkoutMayHaveExecuted(new Error('unknown'))).toBe(true);
  });
});

describe('createRosskoClient.checkoutDetails and orders', () => {
  it('maps GetCheckoutDetails with critical priority', async () => {
    const { instance, calls, events } = client();
    const details = await instance.checkoutDetails();
    expect(calls[0]).toEqual({ method: 'GetCheckoutDetails', args: { KEY1, KEY2 } });
    expect(details.deliveries.map((d) => d.id)).toEqual(['000000001', '000000002']);
    expect(events[0]?.priority).toBe('critical');
  });

  it('splits more than 20 ids into batches and skips the call for an empty list', async () => {
    const { instance, calls } = client();
    expect(await instance.orders([])).toEqual({ success: true, message: null, orders: [] });
    expect(calls).toHaveLength(0);

    const ids = Array.from({ length: 45 }, (_, i) => String(70000000 + i));
    const result = await instance.orders([...ids, ids[0] ?? '', '  ']);
    expect(calls.map((c) => (c.args.order_ids as { id: string[] }).id.length)).toEqual([20, 20, 5]);
    expect(calls[0]?.args).toMatchObject({ KEY1, KEY2 });
    // the fixture returns the same two orders for every batch
    expect(result.orders).toHaveLength(6);
  });
});

describe('createRosskoCaller', () => {
  it('fixtures mode answers from bundled fixtures without network', async () => {
    const caller = createRosskoCaller({
      mode: 'fixtures',
      wsdlBase: 'https://unused',
      timeoutMs: 1,
    });
    await expect(caller.call('GetSearch', { text: 'OC90' })).resolves.toHaveProperty(
      'SearchResult',
    );
  });

  it('live mode builds a lazy SOAP caller (no network until the first call)', () => {
    const caller = createRosskoCaller({ mode: 'live', wsdlBase: 'https://unused', timeoutMs: 1 });
    expect(caller.lastRawResponse).toBeNull();
  });
});
