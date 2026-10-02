import { describe, expect, it } from 'vitest';
import {
  CartError,
  cartLineFromOffer,
  cartTotals,
  DEFAULT_EXCLUDED_RULES,
  itemsHashPayload,
  lineTitle,
  MAX_LINE_QTY,
  MoneyError,
  repriceCartLines,
  selectCartPart,
  splitCartLines,
  validateQty,
} from '../src';
import type { CartLine, MarkupRule, Offer, RepriceContext } from '../src/types';

const RULES: MarkupRule[] = [
  { fromKop: 0, toKop: 100_000, localBp: 2800, orderBp: 2800 },
  { fromKop: 100_000, toKop: null, localBp: 2800, orderBp: 2800 },
];

const ctx: RepriceContext = {
  markupRules: RULES,
  excludedRules: DEFAULT_EXCLUDED_RULES,
  eta: { bufferDays: 1, invoiceLagDays: 1, prepayInvoice: false },
  now: new Date('2026-10-01T10:00:00Z'),
};

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
    priceSupplierKop: 41_250,
    ...rest,
    stock: {
      stockId: 'ORB1',
      isLocal: true,
      count: 6,
      multiplicity: 1,
      type: null,
      deliveryDays: 0,
      deliveryStart: null,
      deliveryEnd: null,
      extra: null,
      description: null,
      ...stock,
    },
  };
}

function line(id: string, o: Offer, qty = 1, search = 'OC90'): CartLine {
  return { id, ...cartLineFromOffer(o, search, qty, ctx) };
}

describe('lineTitle', () => {
  it('is brand and article', () => {
    expect(lineTitle(offer())).toBe('Knecht OC 90');
    expect(lineTitle(offer({ brand: ' MANN ', article: 'W  712/75' }))).toBe('MANN W 712/75');
  });
});

describe('validateQty', () => {
  it('accepts integers 1..99 within stock and multiplicity', () => {
    expect(validateQty(1, { available: 6, multiplicity: 1 })).toEqual({ ok: true });
    expect(validateQty(4, { available: 6, multiplicity: 2 })).toEqual({ ok: true });
    expect(validateQty(99, { available: 200, multiplicity: 1 })).toEqual({ ok: true });
  });

  it.each([
    [0, 6, 1],
    [-1, 6, 1],
    [1.5, 6, 1],
    [Number.NaN, 6, 1],
    [MAX_LINE_QTY + 1, 500, 1],
    [3, 6, 2],
    [7, 6, 1],
    [1, 0, 1],
    [2, 1, 2],
  ])('rejects qty %s (available %s, multiplicity %s)', (qty, available, multiplicity) => {
    const result = validateQty(qty, { available, multiplicity });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });

  it('explains the reason', () => {
    expect(validateQty(7, { available: 6, multiplicity: 1 })).toEqual({
      ok: false,
      message: 'В наличии только 6 шт.',
    });
    expect(validateQty(3, { available: 6, multiplicity: 2 })).toMatchObject({
      message: expect.stringContaining('кратно 2'),
    });
  });
});

describe('cartLineFromOffer', () => {
  it('prices the line: 412,50 ₽ x 1.28 -> 528 ₽, date from the stock', () => {
    const result = cartLineFromOffer(offer(), 'OC90', 2, ctx);
    expect(result).toMatchObject({
      offerKey: 'OC90:Knecht:ORB1',
      searchArticleNorm: 'OC90',
      qty: 2,
      priceSupplierKop: 41_250,
      priceClientKop: 52_800,
      markupBp: 2800,
      isLocal: true,
      etaDate: '2026-10-01',
    });
    expect(result.offer.brand).toBe('Knecht');
  });

  it('keeps the query article of a cross', () => {
    const cross = offer({ brand: 'MANN', article: 'W 712/75', articleNorm: 'W71275' });
    expect(cartLineFromOffer(cross, 'OC90', 1, ctx)).toMatchObject({
      offerKey: 'W71275:MANN:ORB1',
      searchArticleNorm: 'OC90',
    });
  });

  it('refuses marked goods, unusable offers, wrong quantities and articles', () => {
    const code = (fn: () => unknown): string | null => {
      try {
        fn();
        return null;
      } catch (error) {
        return error instanceof CartError ? error.code : 'other';
      }
    };
    expect(
      code(() => cartLineFromOffer(offer({ name: 'Масло моторное 5W-40' }), 'X1', 1, ctx)),
    ).toBe('excluded');
    expect(code(() => cartLineFromOffer(offer({ priceSupplierKop: 0 }), 'OC90', 1, ctx))).toBe(
      'price',
    );
    expect(
      code(() =>
        cartLineFromOffer(
          offer({ stock: { deliveryDays: null, deliveryEnd: null } }),
          'OC90',
          1,
          ctx,
        ),
      ),
    ).toBe('price');
    expect(code(() => cartLineFromOffer(offer(), 'OC90', 7, ctx))).toBe('qty');
    expect(code(() => cartLineFromOffer(offer(), 'oc90', 1, ctx))).toBe('article');
    expect(code(() => cartLineFromOffer(offer(), '', 1, ctx))).toBe('article');
  });
});

describe('repriceCartLines', () => {
  const base = offer();
  const lines = [line('a', base, 6)];

  it('detects a price rise per unit (+53 ₽) and refreshes the snapshot', () => {
    const fresh = offer({ priceSupplierKop: 45_390, stock: { count: 10, deliveryDays: 2 } });
    const result = repriceCartLines(lines, new Map([['OC90', [fresh]]]), ctx);
    expect(result.changes).toEqual([
      {
        kind: 'price',
        lineId: 'a',
        offerKey: 'OC90:Knecht:ORB1',
        title: 'Knecht OC 90',
        oldPriceKop: 52_800,
        newPriceKop: 58_100,
        deltaKop: 5_300,
      },
    ]);
    expect(result.lines[0]).toMatchObject({
      status: 'ok',
      stale: false,
      priceSupplierKop: 45_390,
      priceClientKop: 58_100,
      etaDate: '2026-10-03',
      available: 10,
      qty: 6,
    });
    expect(result.lines[0]?.offer.priceSupplierKop).toBe(45_390);
  });

  it('cuts the quantity to the stock (6 -> 2)', () => {
    const result = repriceCartLines(
      lines,
      new Map([['OC90', [offer({ stock: { count: 2 } })]]]),
      ctx,
    );
    expect(result.changes).toEqual([
      {
        kind: 'qty',
        lineId: 'a',
        offerKey: 'OC90:Knecht:ORB1',
        title: 'Knecht OC 90',
        oldQty: 6,
        newQty: 2,
      },
    ]);
    expect(result.lines[0]).toMatchObject({ status: 'ok', qty: 2, available: 2 });
  });

  it('cuts to the largest multiple of a new multiplicity; nothing left -> unavailable', () => {
    const r1 = repriceCartLines(
      lines,
      new Map([['OC90', [offer({ stock: { count: 5, multiplicity: 2 } })]]]),
      ctx,
    );
    expect(r1.lines[0]).toMatchObject({ qty: 4, multiplicity: 2 });
    const single = [line('b', base, 1)];
    const r2 = repriceCartLines(
      single,
      new Map([['OC90', [offer({ stock: { count: 5, multiplicity: 2 } })]]]),
      ctx,
    );
    expect(r2.lines[0]?.status).toBe('unavailable');
    expect(r2.changes.map((c) => c.kind)).toEqual(['unavailable']);
  });

  it('marks a vanished or unusable offer unavailable', () => {
    for (const fresh of [
      [],
      [offer({ brand: 'MANN' })],
      [offer({ priceSupplierKop: 0 })],
      [offer({ stock: { deliveryDays: null } })],
      [offer({ stock: { count: 0 } })],
    ]) {
      const result = repriceCartLines(lines, new Map([['OC90', fresh]]), ctx);
      expect(result.lines[0]?.status).toBe('unavailable');
      expect(result.changes).toEqual([
        { kind: 'unavailable', lineId: 'a', offerKey: 'OC90:Knecht:ORB1', title: 'Knecht OC 90' },
      ]);
    }
  });

  it('marks a line excluded when a stop rule now matches', () => {
    const result = repriceCartLines(lines, new Map([['OC90', [base]]]), {
      ...ctx,
      excludedRules: [{ kind: 'keyword', pattern: 'фильтр*', reason: 'Проверка' }],
    });
    expect(result.lines[0]?.status).toBe('excluded');
    expect(result.changes).toEqual([
      {
        kind: 'excluded',
        lineId: 'a',
        offerKey: 'OC90:Knecht:ORB1',
        title: 'Knecht OC 90',
        reason: 'Проверка',
      },
    ]);
  });

  it('picks the cheapest of duplicate offers', () => {
    const result = repriceCartLines(
      lines,
      new Map([
        ['OC90', [offer({ priceSupplierKop: 50_000 }), offer({ priceSupplierKop: 41_250 })]],
      ]),
      ctx,
    );
    expect(result.changes).toEqual([]);
    expect(result.lines[0]?.priceClientKop).toBe(52_800);
  });

  it('keeps lines unchanged (stale) when the search for their article failed', () => {
    const result = repriceCartLines(lines, new Map([['OC90', null]]), ctx);
    expect(result.changes).toEqual([]);
    expect(result.lines[0]).toMatchObject({ ...lines[0], status: 'ok', stale: true, available: 6 });
    expect(repriceCartLines(lines, new Map(), ctx).lines[0]?.stale).toBe(true);
  });

  it('searches crosses by their query article', () => {
    const cross = offer({ brand: 'MANN', article: 'W 712/75', articleNorm: 'W71275' });
    const crossLine = [line('c', cross, 1, 'OC90')];
    const result = repriceCartLines(
      crossLine,
      new Map<string, Offer[] | null>([
        ['OC90', [base, cross]],
        ['W71275', null],
      ]),
      ctx,
    );
    expect(result.lines[0]).toMatchObject({ status: 'ok', stale: false });
  });
});

describe('cartTotals', () => {
  it('sums client, supplier and margin in kopecks', () => {
    const totals = cartTotals([
      { qty: 2, priceClientKop: 52_800, priceSupplierKop: 41_250 },
      { qty: 1, priceClientKop: 100_000, priceSupplierKop: 80_000 },
    ]);
    expect(totals).toEqual({
      subtotalKop: 205_600,
      supplierKop: 162_500,
      marginKop: 43_100,
      itemsCount: 3,
    });
    expect(cartTotals([])).toEqual({ subtotalKop: 0, supplierKop: 0, marginKop: 0, itemsCount: 0 });
  });

  it('allows a negative margin and fails on overflow', () => {
    expect(cartTotals([{ qty: 1, priceClientKop: 100, priceSupplierKop: 200 }]).marginKop).toBe(
      -100,
    );
    expect(() =>
      cartTotals([{ qty: 99, priceClientKop: Number.MAX_SAFE_INTEGER, priceSupplierKop: 1 }]),
    ).toThrow(MoneyError);
  });
});

describe('splitCartLines and selectCartPart', () => {
  const local = { id: 'l', isLocal: true };
  const remote = { id: 'r', isLocal: false };

  it('splits a mixed cart', () => {
    expect(splitCartLines([local, remote])).toEqual({
      local: [local],
      toOrder: [remote],
      mixed: true,
    });
    expect(splitCartLines([local])).toEqual({ local: [local], toOrder: [], mixed: false });
  });

  it('selects a part of a mixed cart and ignores the part for a homogeneous one', () => {
    expect(selectCartPart([local, remote], 'all')).toEqual([local, remote]);
    expect(selectCartPart([local, remote], 'local')).toEqual([local]);
    expect(selectCartPart([local, remote], 'order')).toEqual([remote]);
    expect(selectCartPart([remote], 'local')).toEqual([remote]);
    expect(selectCartPart([local], 'order')).toEqual([local]);
    expect(selectCartPart([], 'all')).toEqual([]);
  });
});

describe('itemsHashPayload', () => {
  const a = { offerKey: 'OC90:Knecht:ORB1', qty: 1, priceClientKop: 52_800 };
  const b = { offerKey: 'W71275:MANN:MSK7', qty: 2, priceClientKop: 64_000 };

  it('is canonical: sorted by offerKey', () => {
    expect(itemsHashPayload([b, a])).toBe('OC90:Knecht:ORB1|1|52800\nW71275:MANN:MSK7|2|64000');
    expect(itemsHashPayload([a, b])).toBe(itemsHashPayload([b, a]));
  });

  it('changes with price and quantity', () => {
    const payload = itemsHashPayload([a, b]);
    expect(itemsHashPayload([{ ...a, qty: 2 }, b])).not.toBe(payload);
    expect(itemsHashPayload([{ ...a, priceClientKop: 52_900 }, b])).not.toBe(payload);
    expect(itemsHashPayload([a])).not.toBe(payload);
  });
});
