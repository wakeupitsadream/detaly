import { describe, expect, it } from 'vitest';
import { buildOfferViews, DEFAULT_EXCLUDED_RULES } from '../src';
import type { MarkupRule, Offer, OfferViewContext } from '../src/types';

const RULES: MarkupRule[] = [
  { fromKop: 0, toKop: 100_000, localBp: 2800, orderBp: 2800 },
  { fromKop: 100_000, toKop: null, localBp: 2800, orderBp: 2800 },
];

function offer(
  over: Partial<Omit<Offer, 'stock'>> & { stock?: Partial<Offer['stock']> } = {},
): Offer {
  const { stock, ...rest } = over;
  return {
    source: 'rossko',
    brand: 'MANN',
    article: 'W 914/2',
    articleNorm: 'W9142',
    name: 'Фильтр масляный',
    group: null,
    isCross: false,
    priceSupplierKop: 50_000,
    ...rest,
    stock: {
      stockId: 'ORB1',
      isLocal: true,
      count: 4,
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

const ctx: OfferViewContext = {
  markupRules: RULES,
  excludedRules: DEFAULT_EXCLUDED_RULES,
  eta: { bufferDays: 1, invoiceLagDays: 1, prepayInvoice: false },
  now: new Date('2026-10-01T10:00:00Z'),
};

describe('buildOfferViews', () => {
  it('builds a ready-to-render row without supplier price', () => {
    const [view] = buildOfferViews([offer()], ctx);
    expect(view).toEqual({
      id: 'W9142:MANN:ORB1',
      brand: 'MANN',
      article: 'W 914/2',
      articleNorm: 'W9142',
      name: 'Фильтр масляный',
      isCross: false,
      isLocal: true,
      stockId: 'ORB1',
      available: 4,
      multiplicity: 1,
      priceClientKop: 64_000,
      priceText: '640 ₽',
      etaDate: '2026-10-01',
      promiseText: 'к пт 2 октября',
      excluded: false,
      excludedReason: null,
    });
    expect(JSON.stringify(view)).not.toContain('50000');
    expect(view).not.toHaveProperty('priceSupplierKop');
    expect(view).not.toHaveProperty('markupBp');
  });

  it('marks excluded goods instead of dropping them', () => {
    const [view] = buildOfferViews(
      [offer({ name: 'Масло моторное 5W-40', articleNorm: 'EDGE5W40' })],
      ctx,
    );
    expect(view?.excluded).toBe(true);
    expect(view?.excludedReason).toBe('Маркируемый товар: масла');
  });

  it('uses deliveryEnd and the invoice lag for the promise', () => {
    const [view] = buildOfferViews(
      [
        offer({
          stock: { isLocal: false, deliveryDays: 5, deliveryEnd: '2026-10-08T22:00+03:00' },
        }),
      ],
      { ...ctx, eta: { bufferDays: 1, invoiceLagDays: 1, prepayInvoice: true } },
    );
    expect(view?.etaDate).toBe('2026-10-09');
    expect(view?.promiseText).toBe('к вс 11 октября');
  });

  it('sorts: requested article, sellable, cheaper, sooner', () => {
    const views = buildOfferViews(
      [
        offer({ isCross: true, brand: 'BIG', articleNorm: 'X1', priceSupplierKop: 1_000 }),
        offer({ stock: { stockId: 'FAR', isLocal: false, deliveryDays: 5 } }),
        offer({ stock: { stockId: 'ORB2' }, priceSupplierKop: 40_000 }),
        offer({ name: 'Масло', stock: { stockId: 'OIL' }, priceSupplierKop: 100 }),
        offer(),
      ],
      ctx,
    );
    expect(views.map((v) => v.stockId)).toEqual(['ORB2', 'ORB1', 'FAR', 'OIL', 'ORB1']);
    expect(views.at(-1)?.isCross).toBe(true);
  });

  it('drops offers with unusable prices and dedupes by id keeping the cheapest', () => {
    const views = buildOfferViews(
      [
        offer({ priceSupplierKop: 0 }),
        offer({ priceSupplierKop: Number.NaN }),
        offer({ priceSupplierKop: 60_000 }),
        offer({ priceSupplierKop: 50_000 }),
      ],
      ctx,
    );
    expect(views).toHaveLength(1);
    expect(views[0]?.priceClientKop).toBe(64_000);
  });

  it('respects the time zone option', () => {
    const late = { ...ctx, now: new Date('2026-10-01T20:30:00Z') };
    expect(buildOfferViews([offer()], late)[0]?.etaDate).toBe('2026-10-02');
    expect(buildOfferViews([offer()], { ...late, timeZone: 'Europe/Moscow' })[0]?.etaDate).toBe(
      '2026-10-01',
    );
  });
});
