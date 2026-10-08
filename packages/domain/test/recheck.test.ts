import { describe, expect, it } from 'vitest';
import {
  applyMarkup,
  basePricingConfig,
  DEFAULT_EXCLUDED_RULES,
  MoneyError,
  offerViewId,
  RECHECK_MAX_ALTERNATIVES,
  RecheckError,
  recheckOrder,
  type RecheckOrderInput,
} from '../src';
import type { RecheckItemInput } from '../src/recheck-types';
import type { MarkupRule, Offer } from '../src/types';

const RULES: MarkupRule[] = [{ fromKop: 0, toKop: null, localBp: 2800, orderBp: 2800 }];
const NOW = new Date('2026-10-02T07:00:00Z'); // 12:00 in Orenburg
const TOLERANCE_BP = 300; // PRICE_DRIFT_TOLERANCE_PCT=3
const FLOOR_BP = 1000; // MARGIN_FLOOR_PCT=10

function offer(
  over: Partial<Omit<Offer, 'stock'>> & { stock?: Partial<Offer['stock']> } = {},
): Offer {
  const { stock, ...rest } = over;
  return {
    source: 'rossko',
    brand: 'Knecht',
    article: 'OC 90',
    articleNorm: 'OC90',
    name: 'Фильтр масляный',
    group: null,
    isCross: false,
    priceSupplierKop: 38_900,
    ...rest,
    stock: {
      stockId: 'MSK7',
      isLocal: false,
      count: 24,
      multiplicity: 1,
      type: '2',
      deliveryDays: 3,
      deliveryStart: null,
      deliveryEnd: null,
      extra: null,
      description: null,
      ...stock,
    },
  };
}

/** The offers of the synthetic GetSearch.OC90 fixture as the mapper returns them. */
const OC90: Offer[] = [
  offer({
    priceSupplierKop: 41_250,
    stock: { stockId: 'ORB1', isLocal: true, count: 6, deliveryDays: 0 },
  }),
  offer(),
  offer({
    brand: 'MAHLE',
    isCross: true,
    priceSupplierKop: 39_810,
    stock: { stockId: 'EKB2', count: 4, deliveryDays: 2 },
  }),
  offer({
    brand: 'MANN-FILTER',
    article: 'W 712/75',
    articleNorm: 'W71275',
    isCross: true,
    priceSupplierKop: 45_500,
    stock: { stockId: 'ORB1', isLocal: true, count: 2, deliveryDays: 0 },
  }),
  offer({
    brand: 'BOSCH',
    article: '0 451 103 079',
    articleNorm: '0451103079',
    isCross: true,
    priceSupplierKop: 50_130,
    stock: { stockId: 'MSK7', count: 10, deliveryDays: 4 },
  }),
];

/** Every supplier price multiplied by factorBp / 10000, rounded half up (fixture-caller rule). */
function scaled(offers: readonly Offer[], factorBp: number): Offer[] {
  return offers.map((o) => ({
    ...o,
    priceSupplierKop: Math.floor((o.priceSupplierKop * factorBp + 5_000) / 10_000),
  }));
}

const KNECHT_MSK7 = OC90[1] as Offer;

function item(over: Partial<RecheckItemInput> = {}): RecheckItemInput {
  const o = over.offer ?? KNECHT_MSK7;
  const priceSupplierKop = over.priceSupplierKop ?? o.priceSupplierKop;
  return {
    orderItemId: 'item-1',
    offerKey: offerViewId(o),
    searchArticleNorm: 'OC90',
    qty: 2,
    priceSupplierKop,
    priceClientKop: applyMarkup(priceSupplierKop, 2800),
    offer: o,
    ...over,
  };
}

function input(over: Partial<RecheckOrderInput> = {}): RecheckOrderInput {
  return {
    items: [item()],
    freshBySearch: { OC90 },
    pricing: basePricingConfig(RULES),
    excludedRules: DEFAULT_EXCLUDED_RULES,
    eta: { bufferDays: 1, invoiceLagDays: 1, prepayInvoice: false },
    now: NOW,
    marginFloorBp: FLOOR_BP,
    driftToleranceBp: TOLERANCE_BP,
    ...over,
  };
}

describe('recheckOrder: price drift (Verification 1B step 5)', () => {
  it('client price of the ordered item is 498 ₽ (389 ₽ + 28%)', () => {
    expect(item().priceClientKop).toBe(49_800);
  });

  it('+1% with a 3% tolerance passes: no reason, no alternatives', () => {
    const result = recheckOrder(input({ freshBySearch: { OC90: scaled(OC90, 10_100) } }));
    expect(result).toEqual({
      items: [
        {
          orderItemId: 'item-1',
          offerKey: 'OC90:Knecht:MSK7',
          status: 'ok',
          qty: 2,
          oldPriceSupplierKop: 38_900,
          freshPriceSupplierKop: 39_289,
          driftBp: 100,
          available: 24,
          alternatives: [],
        },
      ],
      priceDriftBp: 100,
      allAvailable: true,
      oldSupplierTotalKop: 77_800,
      freshSupplierTotalKop: 78_578,
      reason: null,
    });
  });

  it('+10% fails with price_drift and offers the MAHLE cross from OC90 at the client price', () => {
    const result = recheckOrder(input({ freshBySearch: { OC90: scaled(OC90, 11_000) } }));
    expect(result.priceDriftBp).toBe(1_000);
    expect(result.allAvailable).toBe(true);
    expect(result.reason).toBe('price_drift');
    const [line] = result.items;
    expect(line?.status).toBe('ok');
    // Knecht ORB1 (453.75 ₽, margin 8.88%), MANN W 712/75 and BOSCH (above 498 ₽) are filtered.
    expect(line?.alternatives).toEqual([
      {
        offer: expect.objectContaining({ brand: 'MAHLE', isCross: true }) as unknown,
        priceClientKop: 49_800,
        priceSupplierKop: 43_791,
        markupBp: 1_372,
        etaDate: '2026-10-04',
        searchArticleNorm: 'OC90',
        offerKey: 'OC90:MAHLE:EKB2',
        marginBp: 1_206,
        available: 4,
      },
    ]);
  });

  it('a lower margin floor lets the local stock of the same article in, cheapest first', () => {
    const result = recheckOrder(
      input({ freshBySearch: { OC90: scaled(OC90, 11_000) }, marginFloorBp: 800 }),
    );
    expect(result.items[0]?.alternatives.map((a) => [a.offerKey, a.marginBp, a.etaDate])).toEqual([
      ['OC90:MAHLE:EKB2', 1_206, '2026-10-04'],
      ['OC90:Knecht:ORB1', 888, '2026-10-02'],
    ]);
  });

  it('order drift is rounded up, so 3.003% does not pass a 3% tolerance', () => {
    const base = offer({ priceSupplierKop: 30_000 });
    const result = recheckOrder(
      input({
        items: [item({ offer: base, qty: 1 })],
        freshBySearch: { OC90: [offer({ priceSupplierKop: 30_901 })] },
      }),
    );
    expect(result.priceDriftBp).toBe(301);
    expect(result.reason).toBe('price_drift');
    const exact = recheckOrder(
      input({
        items: [item({ offer: base, qty: 1 })],
        freshBySearch: { OC90: [offer({ priceSupplierKop: 30_900 })] },
      }),
    );
    expect(exact.priceDriftBp).toBe(300);
    expect(exact.reason).toBeNull();
  });

  it('order drift weights items by qty; a cheaper item offsets a dearer one', () => {
    const w = offer({
      brand: 'MANN-FILTER',
      article: 'W 914/2',
      articleNorm: 'W9142',
      priceSupplierKop: 62_340,
      stock: { count: 12 },
    });
    const result = recheckOrder(
      input({
        items: [
          item({ qty: 2 }),
          item({ orderItemId: 'item-2', offer: w, searchArticleNorm: 'W9142', qty: 1 }),
        ],
        freshBySearch: {
          OC90: [offer({ priceSupplierKop: 42_790 })], // +10%
          W9142: [{ ...w, priceSupplierKop: 58_000 }], // −6.96%
        },
      }),
    );
    // (85 580 + 58 000) − (77 800 + 62 340) = 3 440; 3 440 · 10000 / 140 140 = 245.47 -> 246
    expect(result.priceDriftBp).toBe(246);
    expect(result.items.map((r) => r.driftBp)).toEqual([1_000, -696]);
    expect(result.reason).toBeNull();
    // The dearer item is still a problem item on its own, but this answer has no other offer.
    expect(result.items[0]?.alternatives).toEqual([]);
  });

  it('a negative drift (cheaper now) passes', () => {
    const result = recheckOrder(input({ freshBySearch: { OC90: scaled(OC90, 9_000) } }));
    expect(result.priceDriftBp).toBe(-1_000);
    expect(result.reason).toBeNull();
  });

  it('without a tolerance only availability decides the reason', () => {
    const result = recheckOrder(
      input({ freshBySearch: { OC90: scaled(OC90, 11_000) }, driftToleranceBp: undefined }),
    );
    expect(result.priceDriftBp).toBe(1_000);
    expect(result.reason).toBeNull();
    expect(result.items[0]?.alternatives).toEqual([]);
  });
});

describe('recheckOrder: availability', () => {
  it('a disappeared offer -> unavailable, allAvailable false, alternatives from the answer', () => {
    const fresh = OC90.filter((o) => offerViewId(o) !== 'OC90:Knecht:MSK7');
    const result = recheckOrder(input({ freshBySearch: { OC90: fresh } }));
    expect(result.allAvailable).toBe(false);
    expect(result.reason).toBe('unavailable');
    expect(result.priceDriftBp).toBe(0);
    expect(result.freshSupplierTotalKop).toBe(0);
    expect(result.oldSupplierTotalKop).toBe(77_800);
    expect(result.items[0]).toMatchObject({
      status: 'unavailable',
      freshPriceSupplierKop: null,
      driftBp: null,
      available: null,
    });
    expect(result.items[0]?.alternatives.map((a) => [a.offerKey, a.marginBp])).toEqual([
      ['OC90:MAHLE:EKB2', 2_006],
      ['OC90:Knecht:ORB1', 1_716],
    ]);
  });

  it('an empty fresh answer (nothing found) is unavailable without alternatives', () => {
    const result = recheckOrder(input({ freshBySearch: new Map([['OC90', []]]) }));
    expect(result.items[0]).toMatchObject({ status: 'unavailable', alternatives: [] });
    expect(result.allAvailable).toBe(false);
  });

  it('drift is computed over the items that still have an offer', () => {
    const w = offer({
      brand: 'MANN-FILTER',
      article: 'W 914/2',
      articleNorm: 'W9142',
      priceSupplierKop: 62_340,
    });
    const result = recheckOrder(
      input({
        items: [
          item(),
          item({ orderItemId: 'item-2', offer: w, searchArticleNorm: 'W9142', qty: 1 }),
        ],
        freshBySearch: { OC90: scaled(OC90, 10_100), W9142: [] },
      }),
    );
    expect(result.priceDriftBp).toBe(100);
    expect(result.items.map((r) => r.status)).toEqual(['ok', 'unavailable']);
    expect(result.reason).toBe('unavailable');
  });

  it('stock below qty -> insufficient; alternatives need stock for the whole qty', () => {
    const fresh = OC90.map((o) =>
      offerViewId(o) === 'OC90:Knecht:MSK7' ? { ...o, stock: { ...o.stock, count: 1 } } : o,
    );
    const result = recheckOrder(
      input({ items: [item({ qty: 5 })], freshBySearch: { OC90: fresh } }),
    );
    expect(result.items[0]).toMatchObject({ status: 'insufficient', available: 1, driftBp: 0 });
    expect(result.allAvailable).toBe(false);
    // MAHLE has 4 < 5, MANN 2 < 5: only the local Knecht stock (6) is left.
    expect(result.items[0]?.alternatives.map((a) => a.offerKey)).toEqual(['OC90:Knecht:ORB1']);
  });

  it('two items of one offer share its stock', () => {
    const fresh = OC90.map((o) =>
      offerViewId(o) === 'OC90:Knecht:MSK7' ? { ...o, stock: { ...o.stock, count: 3 } } : o,
    );
    const result = recheckOrder(
      input({
        items: [item({ qty: 2 }), item({ orderItemId: 'item-2', qty: 2 })],
        freshBySearch: { OC90: fresh },
      }),
    );
    expect(result.items.map((r) => r.status)).toEqual(['insufficient', 'insufficient']);
  });

  it('an offer that now falls into an excluded group -> excluded; excluded offers are no alternatives', () => {
    const fresh = OC90.map((o) =>
      o.brand === 'MAHLE' || offerViewId(o) === 'OC90:Knecht:MSK7'
        ? { ...o, name: 'Масло моторное' }
        : o,
    );
    const result = recheckOrder(input({ freshBySearch: { OC90: fresh } }));
    expect(result.items[0]?.status).toBe('excluded');
    expect(result.reason).toBe('unavailable');
    expect(result.items[0]?.alternatives.map((a) => a.offerKey)).toEqual(['OC90:Knecht:ORB1']);
  });

  it('alternatives: at most three, cheapest first, multiplicity respected, no date -> skipped', () => {
    const many: Offer[] = [
      ...[30_000, 31_000, 32_000, 33_000].map((p, i) =>
        offer({ brand: `B${i}`, isCross: true, priceSupplierKop: p, stock: { stockId: `S${i}` } }),
      ),
      offer({
        brand: 'CHEAP',
        isCross: true,
        priceSupplierKop: 20_000,
        stock: { stockId: 'X', multiplicity: 4 },
      }),
      offer({
        brand: 'NODATE',
        isCross: true,
        priceSupplierKop: 20_000,
        stock: { stockId: 'Y', deliveryDays: null },
      }),
    ];
    const result = recheckOrder(input({ freshBySearch: { OC90: many } }));
    expect(result.items[0]?.status).toBe('unavailable');
    expect(result.items[0]?.alternatives).toHaveLength(RECHECK_MAX_ALTERNATIVES);
    expect(result.items[0]?.alternatives.map((a) => a.offer.brand)).toEqual(['B0', 'B1', 'B2']);
  });
});

describe('recheckOrder: input errors', () => {
  it('a missing fresh search result throws (a failed search is retried, not "gone")', () => {
    expect(() => recheckOrder(input({ freshBySearch: {} }))).toThrow(RecheckError);
    expect(() => recheckOrder(input({ freshBySearch: new Map() }))).toThrow(
      'no fresh search result for OC90',
    );
  });

  it('rejects an empty order, bad qty and bad prices', () => {
    expect(() => recheckOrder(input({ items: [] }))).toThrow(RecheckError);
    expect(() => recheckOrder(input({ items: [item({ qty: 0 })] }))).toThrow(RecheckError);
    expect(() => recheckOrder(input({ items: [item({ priceClientKop: 0 })] }))).toThrow(MoneyError);
    expect(() => recheckOrder(input({ marginFloorBp: 0.5 }))).toThrow(RecheckError);
  });
});
