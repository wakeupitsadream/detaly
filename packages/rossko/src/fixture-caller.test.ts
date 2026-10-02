import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkoutMayHaveExecuted, RosskoCallError } from './errors';
import {
  BUNDLED_FIXTURES,
  createFixtureCaller,
  FIXTURE_TIMEOUT_MESSAGE,
  fixtureName,
} from './fixture-caller';
import { mapCheckoutResult, mapOrdersResult, mapSearchResult } from './mapper';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

describe('fixtures', () => {
  it('bundled set equals the files on disk', async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
    expect(files.map((f) => f.replace(/\.json$/, ''))).toEqual(
      Object.keys(BUNDLED_FIXTURES).sort(),
    );
    for (const file of files) {
      const onDisk: unknown = JSON.parse(await readFile(`${FIXTURES_DIR}/${file}`, 'utf8'));
      expect(onDisk).toEqual(BUNDLED_FIXTURES[file.replace(/\.json$/, '')]);
    }
  });

  it('every fixture is marked synthetic with a note to verify', () => {
    for (const [name, value] of Object.entries(BUNDLED_FIXTURES)) {
      expect(value, name).toMatchObject({
        _meta: { synthetic: true, note: expect.stringContaining('сверить') as unknown },
      });
    }
  });
});

describe('fixtureName', () => {
  it('derives the file name from method and args', () => {
    expect(fixtureName('GetSearch', { text: 'oc 90' })).toBe('GetSearch.OC90');
    expect(fixtureName('GetSearch', { text: '' })).toBe('GetSearch.NOTFOUND');
    expect(fixtureName('GetCheckout', {})).toBe('GetCheckout.ok');
    expect(fixtureName('GetCheckout', {}, 'itemErrors')).toBe('GetCheckout.itemErrors');
    expect(fixtureName('GetCheckoutDetails', {})).toBe('GetCheckoutDetails');
    expect(fixtureName('GetOrders', { order_ids: { id: ['1'] } })).toBe('GetOrders');
    expect(fixtureName('GetOrders', { KEY1: '', KEY2: '' })).toBe('GetOrders.recent');
    expect(fixtureName('GetOrders', {}, 'ok', 'unsupported')).toBe('GetOrders.unsupported');
  });
});

describe.each([
  ['bundled', () => createFixtureCaller()],
  ['directory', () => createFixtureCaller(FIXTURES_DIR)],
])('createFixtureCaller (%s)', (_label, make) => {
  it('answers GetSearch by normalized text and strips _meta', async () => {
    const raw = await make().call('GetSearch', { KEY1: '', KEY2: '', text: 'oc-90' });
    expect(raw).not.toHaveProperty('_meta');
    expect(raw).toHaveProperty('SearchResult.success', true);
    expect(mapSearchResult(raw, { localStockIds: ['ORB1'] })).toHaveLength(5);
  });

  it('answers unknown articles with NOTFOUND', async () => {
    const raw = await make().call('GetSearch', { text: 'NO-SUCH-PART' });
    expect(raw).toEqual({ SearchResult: { success: false, message: 'Ничего не найдено' } });
  });

  it('returns copies: mutating a response does not leak into the next one', async () => {
    const caller = make();
    const first = (await caller.call('GetSearch', { text: 'W9142' })) as {
      SearchResult: { success: boolean };
    };
    first.SearchResult.success = false;
    const second = await caller.call('GetSearch', { text: 'W9142' });
    expect(second).toHaveProperty('SearchResult.success', true);
  });
});

describe('createFixtureCaller options', () => {
  it('serves GetCheckout.itemErrors on request', async () => {
    const raw = await createFixtureCaller({ checkoutVariant: 'itemErrors' }).call(
      'GetCheckout',
      {},
    );
    expect(mapCheckoutResult(raw).itemErrors).toHaveLength(1);
  });

  it('fails loudly for a missing non-search fixture in a directory', async () => {
    const caller = createFixtureCaller(fileURLToPath(new URL('../test', import.meta.url)));
    await expect(caller.call('GetOrders', {})).rejects.toThrow(
      'Rossko fixture not found: GetOrders.json',
    );
  });
});

describe('createFixtureCaller: priceFactorBp (recheck +1% / +10%)', () => {
  const prices = async (factor?: number) =>
    mapSearchResult(
      await createFixtureCaller({ priceFactorBp: factor }).call('GetSearch', { text: 'OC90' }),
      { localStockIds: ['ORB1'] },
    ).map((o) => [`${o.brand}:${o.stock.stockId}`, o.priceSupplierKop]);

  it('scales every stock of parts and crosses, rounding kopecks half up', async () => {
    expect(await prices()).toEqual([
      ['Knecht:ORB1', 41_250],
      ['Knecht:MSK7', 38_900],
      ['MAHLE:EKB2', 39_810],
      ['MANN-FILTER:ORB1', 45_500],
      ['BOSCH:MSK7', 50_130],
    ]);
    expect(await prices(10_100)).toEqual([
      ['Knecht:ORB1', 41_663], // 41 662.5 -> 41 663
      ['Knecht:MSK7', 39_289],
      ['MAHLE:EKB2', 40_208], // 40 208.1
      ['MANN-FILTER:ORB1', 45_955],
      ['BOSCH:MSK7', 50_631], // 50 631.3
    ]);
    expect(await prices(11_000)).toEqual([
      ['Knecht:ORB1', 45_375],
      ['Knecht:MSK7', 42_790],
      ['MAHLE:EKB2', 43_791],
      ['MANN-FILTER:ORB1', 50_050],
      ['BOSCH:MSK7', 55_143],
    ]);
  });

  it('keeps zero prices (still dropped by the mapper) and leaves other methods alone', async () => {
    const caller = createFixtureCaller({ priceFactorBp: 11_000 });
    const raw = (await caller.call('GetSearch', { text: 'OC90' })) as {
      SearchResult: { PartsList: { Part: { crosses: { Part: { stocks: unknown }[] } }[] } };
    };
    expect(raw.SearchResult.PartsList.Part[0]?.crosses.Part[1]?.stocks).toMatchObject({
      stock: [{ price: '500.50' }, { price: '0.00' }],
    });
    expect(mapCheckoutResult(await caller.call('GetCheckout', {})).items[0]?.priceKop).toBe(41_250);
  });

  it('rejects a delta passed as a factor', () => {
    expect(() => createFixtureCaller({ priceFactorBp: 100 })).toThrow(/10100 = \+1%/);
    expect(() => createFixtureCaller({ priceFactorBp: 10_000.5 })).toThrow(RangeError);
  });
});

describe('createFixtureCaller: GetCheckout timeout and the GetOrders list mode', () => {
  const checkoutArgs = {
    KEY1: 'k1',
    KEY2: 'k2',
    comment: 'DT-000777/2',
    PARTS: {
      Part: [
        { partnumber: 'OC 90', brand: 'Knecht', stock: 'MSK7', count: 2 },
        { partnumber: 'W 914/2', brand: 'MANN-FILTER', stock: 'MSK7', count: 1 },
      ],
    },
  };

  it('timeout: throws a timeout that may have executed, and the order shows up in the list', async () => {
    const now = new Date('2026-10-02T12:20:00Z');
    const caller = createFixtureCaller({ checkoutVariant: 'timeout', now: () => now });
    const error: unknown = await caller.call('GetCheckout', checkoutArgs).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RosskoCallError);
    expect(error).toMatchObject({
      timeout: true,
      message: `Rossko GetCheckout: ${FIXTURE_TIMEOUT_MESSAGE}`,
    });
    expect(checkoutMayHaveExecuted(error)).toBe(true);

    const list = mapOrdersResult(await caller.call('GetOrders', { KEY1: 'k1', KEY2: 'k2' }));
    expect(list.orders[0]).toEqual({
      id: '79000001',
      statusCode: 1,
      statusText: 'В работе',
      createdAt: '2026-10-02T12:20:00.000Z',
      comment: 'DT-000777/2',
      items: [
        {
          brand: 'Knecht',
          article: 'OC 90',
          stockId: 'MSK7',
          count: 2,
          priceKop: null,
          statusCode: 1,
        },
        {
          brand: 'MANN-FILTER',
          article: 'W 914/2',
          stockId: 'MSK7',
          count: 1,
          priceKop: null,
          statusCode: 1,
        },
      ],
    });
    // the bundled recent orders follow; by-id GetOrders is unchanged
    expect(list.orders.map((o) => o.id).slice(1)).toEqual([
      '70000012',
      '70000011',
      '70000010',
      '70000009',
    ]);
    const byId = mapOrdersResult(
      await caller.call('GetOrders', { order_ids: { id: ['70000001'] } }),
    );
    expect(byId.orders.map((o) => o.id)).toEqual(['70000001', '70000002']);
  });

  it('timeoutNotExecuted: the same error, nothing recorded', async () => {
    const caller = createFixtureCaller({ checkoutVariant: 'timeoutNotExecuted' });
    await expect(caller.call('GetCheckout', checkoutArgs)).rejects.toMatchObject({ timeout: true });
    const list = mapOrdersResult(await caller.call('GetOrders', {}));
    expect(list.orders.map((o) => o.id)).toEqual(['70000012', '70000011', '70000010', '70000009']);
  });

  it('ordersList unsupported answers success=false', async () => {
    const raw = await createFixtureCaller({ ordersList: 'unsupported' }).call('GetOrders', {});
    expect(mapOrdersResult(raw)).toEqual({
      success: false,
      message: 'Не указаны номера заказов',
      orders: [],
    });
  });

  it('a directory without GetOrders.recent.json falls back to GetOrders.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rossko-fixtures-'));
    try {
      await copyFile(join(FIXTURES_DIR, 'GetOrders.json'), join(dir, 'GetOrders.json'));
      const raw = await createFixtureCaller(dir).call('GetOrders', {});
      expect(mapOrdersResult(raw).orders.map((o) => o.id)).toEqual(['70000001', '70000002']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
