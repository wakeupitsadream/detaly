// Step 8 (docs/rossko-automation.md), the pure parts of the seller card: the shadow auto-order as
// one line, and the headlines of the deadline alerts and of the GetOrders «shipped» push.
import { describe, expect, it } from 'vitest';
import { headlineFor, renderCardText, type CardData } from '../src/bots/seller/card-view';

const ORDER_ID = '0192f0c4-0000-7000-8000-00000000a801';

function cardData(overrides: Partial<CardData> = {}): CardData {
  return {
    order: {
      id: ORDER_ID,
      number: 'DT-000123',
      status: 'ordering',
      paymentScheme: 'prepay',
      totalKop: 192_000,
      createdAt: new Date('2026-10-12T05:00:00Z'),
      promisedDate: '2026-10-14',
      attentionReason: null,
      supplierReturnDeadlineAt: null,
    },
    items: [{ id: 'i1', brand: 'Knecht', article: 'OC 90', qty: 1, state: 'pending' }],
    phone: '+79161234567',
    actions: [],
    adminUrl: `https://detaly.test/admin/orders/${ORDER_ID}`,
    ...overrides,
  };
}

const lines = (data: CardData) =>
  renderCardText(data)
    .replace(/\u00a0/gu, ' ')
    .split('\n');

describe('the shadow auto-order on the seller card', () => {
  it('«Автозаказ бы: ДА» as one line', () => {
    const text = lines(
      cardData({ autoOrder: { decision: 'yes', reasons: [], maxTotalKop: null } }),
    );
    expect(text.filter((line) => line.startsWith('Автозаказ бы'))).toEqual(['Автозаказ бы: ДА']);
  });

  it('«Автозаказ бы: НЕТ — <причины>» with the limit of the decision', () => {
    const text = lines(
      cardData({
        order: { ...cardData().order, status: 'needs_attention', attentionReason: 'price_drift' },
        autoOrder: {
          decision: 'no',
          reasons: ['price_drift', 'total_over_limit'],
          maxTotalKop: 1_500_000,
        },
      }),
    );
    expect(text).toContain('Внимание: цена у Rossko выросла больше допуска');
    expect(text.filter((line) => line.startsWith('Автозаказ бы'))).toEqual([
      'Автозаказ бы: НЕТ — цена у поставщика выросла больше допуска, сумма больше 15 000 ₽',
    ]);
    // The line comes right after the attention line.
    const at = text.indexOf('Внимание: цена у Rossko выросла больше допуска');
    expect(text[at + 1]).toMatch(/^Автозаказ бы: НЕТ/u);
  });

  it('no line without a decision', () => {
    expect(renderCardText(cardData())).not.toContain('Автозаказ бы');
    expect(renderCardText(cardData({ autoOrder: null }))).not.toContain('Автозаказ бы');
  });
});

describe('headlines of the step 8 cards', () => {
  it('the deadline alerts and «Отгружено Rossko»', () => {
    expect(headlineFor('staff_not_ordered')).toBe('Не заказано у поставщика');
    expect(headlineFor('staff_supplier_late')).toBe('Срок поставщика под угрозой');
    expect(headlineFor('staff_supplier_overdue')).toBe('Срок сорван');
    expect(headlineFor('staff_not_picked_up')).toBe('Не забирают');
    expect(headlineFor('staff_supplier_shipped')).toBe('Отгружено Rossko');
    const text = renderCardText(
      cardData({
        headline: headlineFor('staff_supplier_shipped'),
        note: 'Rossko отгрузил заказ DT-000123 на точку — проверьте приёмку (Rossko № 70000010).',
      }),
    );
    expect(text.split('\n')[0]).toBe('Отгружено Rossko DT-000123');
    expect(text).toContain('проверьте приёмку');
  });
});
