import { describe, expect, it } from 'vitest';
import { BUNDLED_FIXTURES, stripMeta } from './fixture-caller';
import {
  applyLocalStocks,
  mapCheckoutDetails,
  mapCheckoutResult,
  mapOrdersResult,
  mapSearchResult,
  parseSearchResponse,
  RosskoResponseError,
} from './mapper';
import { field, toArray } from './raw';

const local = { localStockIds: ['ORB1'] };
const fixture = (name: string): unknown => stripMeta(BUNDLED_FIXTURES[name]);

describe('toArray', () => {
  it('wraps single objects and drops null/undefined', () => {
    expect(toArray(undefined)).toEqual([]);
    expect(toArray(null)).toEqual([]);
    expect(toArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(toArray([1, 2])).toEqual([1, 2]);
  });
});

describe('mapSearchResult: GetSearch.OC90 (local and remote stocks, crosses)', () => {
  const offers = mapSearchResult(fixture('GetSearch.OC90'), local);

  it('maps the requested article on a local stock exactly', () => {
    expect(offers[0]).toEqual({
      source: 'rossko',
      brand: 'Knecht',
      article: 'OC 90',
      articleNorm: 'OC90',
      name: 'Фильтр масляный',
      group: null,
      isCross: false,
      priceSupplierKop: 41250,
      stock: {
        stockId: 'ORB1',
        isLocal: true,
        count: 6,
        multiplicity: 1,
        type: '1',
        deliveryDays: 0,
        deliveryStart: null,
        deliveryEnd: null,
        extra: null,
        description: 'Оренбург',
      },
    });
  });

  it('flattens part x stock, flags crosses, drops zero price and duplicates', () => {
    expect(
      offers.map((o) => [
        o.brand,
        o.articleNorm,
        o.stock.stockId,
        o.isCross,
        o.stock.isLocal,
        o.priceSupplierKop,
      ]),
    ).toEqual([
      ['Knecht', 'OC90', 'ORB1', false, true, 41250],
      ['Knecht', 'OC90', 'MSK7', false, false, 38900],
      ['MAHLE', 'OC90', 'EKB2', true, false, 39810],
      ['MANN-FILTER', 'W71275', 'ORB1', true, true, 45500],
      ['BOSCH', '0451103079', 'MSK7', true, false, 50130],
    ]);
  });

  it('parses string numbers, ">10" counts and defaults multiplicity to 1', () => {
    const remote = offers[1];
    expect(remote?.stock).toMatchObject({ count: 24, multiplicity: 1, type: '2', deliveryDays: 3 });
    const bosch = offers.find((o) => o.brand === 'BOSCH');
    expect(bosch?.stock).toMatchObject({ count: 10, multiplicity: 1, deliveryDays: 4 });
  });

  it('is pure JSON (survives a cache round trip)', () => {
    expect(JSON.parse(JSON.stringify(offers))).toEqual(offers);
  });
});

describe('mapSearchResult: GetSearch.W9142 (single objects instead of arrays)', () => {
  it('accepts a single Part and a single stock', () => {
    const offers = mapSearchResult(fixture('GetSearch.W9142'), local);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      brand: 'MANN-FILTER',
      article: 'W 914/2',
      articleNorm: 'W9142',
      isCross: false,
      priceSupplierKop: 62340,
      stock: { stockId: 'MSK7', isLocal: false, count: 12, multiplicity: 1, deliveryDays: 3 },
    });
  });
});

describe('mapSearchResult: GetSearch.GDB1330 (two brands)', () => {
  const offers = mapSearchResult(fixture('GetSearch.GDB1330'), local);

  it('keeps both brands of the same article', () => {
    expect(offers.map((o) => `${o.brand}:${o.stock.stockId}`)).toEqual([
      'TRW:ORB1',
      'TRW:SPB3',
      'LUCAS:MSK7',
    ]);
    expect(new Set(offers.map((o) => o.articleNorm))).toEqual(new Set(['GDB1330']));
    expect(offers.every((o) => !o.isCross)).toBe(true);
  });

  it('keeps deliveryStart/deliveryEnd as received and turns empty ones into null', () => {
    expect(offers[1]?.stock).toMatchObject({
      deliveryDays: 5,
      deliveryStart: '2026-10-06T09:00:00+03:00',
      deliveryEnd: '2026-10-08T22:00:00+03:00',
    });
    expect(offers[2]?.stock).toMatchObject({ deliveryEnd: null, deliveryStart: null });
  });

  it('parses a comma decimal price and a multiplicity of 2', () => {
    expect(offers[2]).toMatchObject({
      priceSupplierKop: 165000,
      stock: { count: 3, multiplicity: 2, deliveryDays: 4 },
    });
  });
});

describe('mapSearchResult: GetSearch.EDGE5W40 (motor oil)', () => {
  it('maps the product group so that domain can exclude it', () => {
    const offers = mapSearchResult(fixture('GetSearch.EDGE5W40'), local);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      brand: 'CASTROL',
      group: 'Моторные масла',
      name: 'Масло моторное Castrol EDGE 5W-40 синтетическое 4 л',
      priceSupplierKop: 389000,
      stock: { isLocal: true },
    });
  });
});

describe('parseSearchResponse: GetSearch.NOTFOUND', () => {
  it('returns success:false with the supplier message and no offers', () => {
    expect(parseSearchResponse(fixture('GetSearch.NOTFOUND'), local)).toEqual({
      success: false,
      message: 'Ничего не найдено',
      offers: [],
    });
    expect(mapSearchResult(fixture('GetSearch.NOTFOUND'), local)).toEqual([]);
  });
});

describe('mapSearchResult robustness', () => {
  const part = (stock: unknown) => ({
    SearchResult: {
      success: 'true',
      PartsList: { Part: { brand: 'X', partnumber: 'AB-1', name: 'n', stocks: { stock } } },
    },
  });

  it('accepts an already unwrapped result and lower-case keys', () => {
    const offers = mapSearchResult(
      {
        success: true,
        partslist: {
          part: [
            {
              brand: 'X',
              partnumber: 'A1',
              stocks: { stock: { id: 7, price: 10, count: 1, delivery: 1 } },
            },
          ],
        },
      },
      local,
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ name: '', stock: { stockId: '7' }, priceSupplierKop: 1000 });
  });

  it('unwraps GetSearchResponse -> SearchResult', () => {
    const raw = { GetSearchResponse: part({ id: 'S', price: '1.00', count: 1, delivery: 0 }) };
    expect(mapSearchResult(raw, local)).toHaveLength(1);
  });

  it.each([
    ['no id', { price: '1.00', count: 1, delivery: 1 }],
    ['bad price', { id: 'S', price: 'abc', count: 1, delivery: 1 }],
    ['negative price', { id: 'S', price: '-1', count: 1, delivery: 1 }],
    ['object price', { id: 'S', price: { x: 1 }, count: 1, delivery: 1 }],
    ['zero count', { id: 'S', price: '1.00', count: 0, delivery: 1 }],
    ['missing count', { id: 'S', price: '1.00', delivery: 1 }],
    ['no delivery term', { id: 'S', price: '1.00', count: 1 }],
    ['negative delivery term only', { id: 'S', price: '1.00', count: 1, delivery: '-1' }],
  ])('drops a stock with %s but keeps the response', (_label, stock) => {
    expect(
      mapSearchResult(part([stock, { id: 'OK', price: '2.00', count: 1, delivery: 1 }]), local),
    ).toHaveLength(1);
  });

  it('unwraps {$value} price nodes and ignores inherited property names', () => {
    const offers = mapSearchResult(
      part([
        { id: 'S', price: { attributes: { cur: 'RUB' }, $value: '12,30' }, count: 1, delivery: 2 },
      ]),
      local,
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]?.priceSupplierKop).toBe(1230);
    // inherited Object.prototype members are not fields
    expect(field({}, 'toString')).toBeUndefined();
    expect(field({ ToString: 'x' }, 'toString')).toBe('x');
  });

  it('keeps a stock with a negative delivery term when deliveryEnd is present', () => {
    const [offer] = mapSearchResult(
      part({ id: 'S', price: '1', count: 1, delivery: -1, deliveryEnd: '2026-10-08' }),
      local,
    );
    expect(offer?.stock).toMatchObject({ deliveryDays: 0, deliveryEnd: '2026-10-08' });
  });

  it('uses deliveryEnd when delivery days are missing, Date values become ISO strings', () => {
    const [offer] = mapSearchResult(
      part({
        id: 'S',
        price: '1',
        count: 1,
        deliveryEnd: new Date('2026-10-08T19:00:00Z'),
        multiplicity: 0,
      }),
      local,
    );
    expect(offer?.stock).toMatchObject({
      deliveryDays: 0,
      deliveryEnd: '2026-10-08T19:00:00.000Z',
      multiplicity: 1,
    });
  });

  it('skips parts without brand or article, and non-object junk', () => {
    const raw = {
      SearchResult: {
        success: true,
        PartsList: {
          Part: [
            null,
            'junk',
            { partnumber: 'A1' },
            { brand: 'B' },
            { brand: 'B', partnumber: '--' },
          ],
        },
      },
    };
    expect(mapSearchResult(raw, local)).toEqual([]);
  });

  it('throws RosskoResponseError on an unrecognizable envelope', () => {
    expect(() => mapSearchResult(null, local)).toThrow(RosskoResponseError);
    expect(() => mapSearchResult('<html>', local)).toThrow(RosskoResponseError);
    expect(() => mapSearchResult({ foo: 1 }, local)).toThrow(RosskoResponseError);
  });
});

describe('applyLocalStocks', () => {
  it('re-applies isLocal from current settings', () => {
    const offers = mapSearchResult(fixture('GetSearch.OC90'), { localStockIds: [] });
    expect(offers.some((o) => o.stock.isLocal)).toBe(false);
    const relabeled = applyLocalStocks(offers, ['MSK7']);
    expect(relabeled.filter((o) => o.stock.isLocal).map((o) => o.brand)).toEqual([
      'Knecht',
      'BOSCH',
    ]);
    // input is not mutated
    expect(offers.some((o) => o.stock.isLocal)).toBe(false);
  });
});

describe('mapCheckoutDetails', () => {
  it('maps deliveries, payments and addresses', () => {
    expect(mapCheckoutDetails(fixture('GetCheckoutDetails'))).toEqual({
      success: true,
      message: null,
      deliveries: [
        { id: '000000001', name: 'Самовывоз со склада', costKop: 0, freeFromKop: null },
        { id: '000000002', name: 'Доставка до адреса', costKop: 30000, freeFromKop: 500000 },
      ],
      payments: [{ id: '1', name: 'Безналичный расчёт' }],
      addresses: [{ id: '1001', text: 'Оренбург, ул. Примерная, 1' }],
    });
  });
});

describe('mapCheckoutResult', () => {
  it('GetCheckout.ok: order ids, delivery cost, items', () => {
    expect(mapCheckoutResult(fixture('GetCheckout.ok'))).toEqual({
      success: true,
      message: null,
      orderIds: ['70000001'],
      deliveryCostKop: 0,
      items: [
        { brand: 'Knecht', article: 'OC 90', stockId: 'ORB1', count: 2, priceKop: 41250 },
        { brand: 'TRW', article: 'GDB1330', stockId: 'ORB1', count: 1, priceKop: 183400 },
      ],
      itemErrors: [],
    });
  });

  it('GetCheckout.itemErrors: single objects, item errors with message', () => {
    const result = mapCheckoutResult(fixture('GetCheckout.itemErrors'));
    expect(result.orderIds).toEqual(['70000002']);
    expect(result.deliveryCostKop).toBe(30000);
    expect(result.items).toHaveLength(1);
    expect(result.itemErrors).toEqual([
      {
        brand: 'MANN-FILTER',
        article: 'W 914/2',
        stockId: 'MSK7',
        count: 1,
        message: 'Недостаточно товара на складе',
      },
    ]);
  });

  it('accepts a scalar OrderIDS and a failed checkout', () => {
    expect(
      mapCheckoutResult({ CheckoutResult: { success: false, message: 'Ошибка', OrderIDS: '5' } }),
    ).toMatchObject({
      success: false,
      message: 'Ошибка',
      orderIds: ['5'],
      items: [],
      itemErrors: [],
    });
  });
});

describe('mapOrdersResult', () => {
  it('GetOrders: arrays and single objects, numeric and string status codes', () => {
    const result = mapOrdersResult(fixture('GetOrders'));
    expect(result.success).toBe(true);
    expect(result.orders.map((o) => [o.id, o.statusCode, o.items.length])).toEqual([
      ['70000001', 3, 2],
      ['70000002', 1, 1],
    ]);
    expect(result.orders[0]).toMatchObject({
      statusText: 'Готов к выдаче',
      createdAt: '2026-10-02T12:30:00+03:00',
    });
    expect(result.orders[1]?.items[0]).toEqual({
      brand: 'Knecht',
      article: 'OC 90',
      count: 1,
      priceKop: 38900,
      statusCode: 1,
    });
  });
});
