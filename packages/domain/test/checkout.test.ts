import { describe, expect, it } from 'vitest';
import {
  checkOrderMinimums,
  MAX_ORDER_TOTAL_KOP,
  choosePaymentScheme,
  explainPaymentScheme,
  resolveTransition,
  splitAdvice,
} from '../src';
import type { PaymentSchemeInput } from '../src/types';

/** formatRub uses non-breaking spaces; tests compare with plain ones. */
const plain = (text: string): string => text.replaceAll(String.fromCharCode(0xa0), ' ');

const LIMIT = 1_500_000;

const input = (over: Partial<PaymentSchemeInput> = {}): PaymentSchemeInput => ({
  allItemsLocal: true,
  totalKop: 1_500_000,
  noShowCount: 1,
  noShowLimit: 2,
  onPickupMaxTotalKop: LIMIT,
  fulfillment: 'pickup',
  ...over,
});

describe('choosePaymentScheme', () => {
  it('all local, 15 000,00 ₽, one no-show -> pay_on_handover', () => {
    expect(choosePaymentScheme(input())).toEqual({ scheme: 'pay_on_handover', reasons: [] });
  });

  it.each<[string, Partial<PaymentSchemeInput>, string[]]>([
    ['15 000,01 ₽', { totalKop: 1_500_001 }, ['over_limit']],
    ['two no-shows', { noShowCount: 2 }, ['no_show']],
    ['a to-order item', { allItemsLocal: false }, ['to_order']],
    ['courier', { fulfillment: 'courier' }, ['courier']],
    [
      'everything at once',
      { allItemsLocal: false, totalKop: 2_000_000, noShowCount: 3, fulfillment: 'courier' },
      ['to_order', 'over_limit', 'no_show', 'courier'],
    ],
  ])('%s -> prepay', (_name, over, reasons) => {
    expect(choosePaymentScheme(input(over))).toEqual({ scheme: 'prepay', reasons });
  });

  it('agrees with the checkout rules of the state machine', () => {
    for (const over of [
      {},
      { totalKop: 1_500_001 },
      { noShowCount: 2 },
      { allItemsLocal: false },
      { fulfillment: 'courier' as const },
    ]) {
      const i = input(over);
      const result = resolveTransition('draft', 'checkout', {
        actor: 'client',
        hasPdConsent: true,
        minOrderTotalKop: 0,
        orderMarginKop: 1,
        minMarginKop: 0,
        ...i,
      });
      const expected =
        choosePaymentScheme(i).scheme === 'prepay' ? 'awaiting_payment' : 'awaiting_confirmation';
      expect(result.ok && result.rule.to).toBe(expected);
    }
  });
});

describe('explainPaymentScheme', () => {
  const explain = (over: Partial<PaymentSchemeInput>) =>
    explainPaymentScheme(choosePaymentScheme(input(over)), { onPickupMaxTotalKop: LIMIT }).map(
      plain,
    );

  it('pay_on_handover', () => {
    expect(explain({})).toEqual([
      'Оплата при получении: все детали есть на складе в Оренбурге, а сумма не больше 15 000 ₽. ' +
        'Оплата в пункте выдачи — с вашего телефона по QR-коду (СБП или карта). Наличные не принимаем.',
    ]);
  });

  it('prepay reasons, the no-show one neutral', () => {
    expect(explain({ allItemsLocal: false })).toEqual([
      'В заказе есть детали под заказ: мы выкупаем их у поставщика, поэтому нужна предоплата 100%.',
    ]);
    expect(explain({ totalKop: 1_600_000 })).toEqual([
      'Сумма заказа больше 15 000 ₽ — для таких заказов нужна предоплата.',
    ]);
    const noShow = explain({ noShowCount: 5 });
    expect(noShow).toEqual(['Для этого номера доступна только предоплата.']);
    expect(noShow.join(' ')).not.toMatch(/неяв/i);
  });

  it('uses the threshold from settings, not a constant', () => {
    const text = explainPaymentScheme(
      { scheme: 'prepay', reasons: ['over_limit'] },
      { onPickupMaxTotalKop: 2_000_000 },
    ).map(plain);
    expect(text).toEqual(['Сумма заказа больше 20 000 ₽ — для таких заказов нужна предоплата.']);
    expect(
      explainPaymentScheme({ scheme: 'prepay', reasons: [] }, { onPickupMaxTotalKop: LIMIT }),
    ).toEqual(['Для этого заказа нужна предоплата 100%.']);
  });
});

describe('splitAdvice', () => {
  const local = (priceClientKop: number) => ({
    isLocal: true,
    qty: 1,
    priceClientKop,
    priceSupplierKop: 1,
  });
  const remote = { isLocal: false, qty: 1, priceClientKop: 100_000, priceSupplierKop: 1 };
  const ctx = { onPickupMaxTotalKop: LIMIT, noShowLimit: 2, minOrderTotalKop: 0, minMarginKop: 0 };

  it('offers the split for a mixed cart whose local part qualifies', () => {
    expect(splitAdvice([local(52_800), remote], ctx)).toEqual({
      offerSplit: true,
      localTotalKop: 52_800,
    });
  });

  it('does not offer it when the local part is above the limit or the cart is homogeneous', () => {
    expect(splitAdvice([local(1_000_000), local(600_000), remote], ctx)).toEqual({
      offerSplit: false,
      localTotalKop: 1_600_000,
    });
    expect(splitAdvice([local(52_800)], ctx).offerSplit).toBe(false);
    expect(splitAdvice([remote], ctx)).toEqual({ offerSplit: false, localTotalKop: 0 });
  });

  it('does not offer it when one part alone is below the order minimums', () => {
    // The whole cart (1 528 ₽) passes a 1 100 ₽ minimum, the local part (528 ₽) does not.
    const minTotal = { ...ctx, minOrderTotalKop: 110_000 };
    expect(splitAdvice([local(52_800), remote], minTotal).offerSplit).toBe(false);
    // The to-order part (1 000 ₽) misses the minimum, the local part (1 200 ₽) reaches it.
    expect(splitAdvice([local(120_000), remote], minTotal).offerSplit).toBe(false);
    expect(splitAdvice([local(120_000), remote, remote], minTotal).offerSplit).toBe(true);
    // Margin: each part needs its own; the thin local line has 28 ₽ of margin.
    const minMargin = { ...ctx, minMarginKop: 10_000 };
    const richRemote = { ...remote, priceSupplierKop: 50_000 };
    const thinLocal = { ...local(52_800), priceSupplierKop: 50_000 };
    expect(splitAdvice([thinLocal, richRemote], minMargin).offerSplit).toBe(false);
    const richLocal = { ...local(52_800), priceSupplierKop: 20_000 };
    expect(splitAdvice([richLocal, richRemote], minMargin).offerSplit).toBe(true);
  });
});

describe('checkOrderMinimums', () => {
  it('rejects totals above MAX_ORDER_TOTAL_KOP (int4 columns, one payment)', () => {
    const base = { marginKop: 1_000_000, minOrderTotalKop: 0, minMarginKop: 0 };
    expect(checkOrderMinimums({ ...base, subtotalKop: MAX_ORDER_TOTAL_KOP })).toEqual({
      ok: true,
    });
    const over = checkOrderMinimums({ ...base, subtotalKop: MAX_ORDER_TOTAL_KOP + 1 });
    expect(over).toMatchObject({ ok: false, code: 'max_total', missingKop: null });
    if (!over.ok) expect(over.message).toMatch(/500\s000/);
    expect(MAX_ORDER_TOTAL_KOP).toBeLessThan(2_147_483_647);
    // 20 lines x 99 units of an expensive part overflow int4: never accepted.
    expect(checkOrderMinimums({ ...base, subtotalKop: 20 * 99 * 2_000_000 })).toMatchObject({
      ok: false,
      code: 'max_total',
    });
    expect(
      checkOrderMinimums({ ...base, subtotalKop: 200_000, maxOrderTotalKop: 100_000 }),
    ).toMatchObject({ ok: false, code: 'max_total' });
  });

  it('zero thresholds mean no minimum', () => {
    expect(
      checkOrderMinimums({ subtotalKop: 100, marginKop: 0, minOrderTotalKop: 0, minMarginKop: 0 }),
    ).toEqual({ ok: true });
  });

  it('asks for the missing amount below the minimum total', () => {
    const result = checkOrderMinimums({
      subtotalKop: 52_800,
      marginKop: 11_550,
      minOrderTotalKop: 100_000,
      minMarginKop: 0,
    });
    expect(result).toMatchObject({ ok: false, code: 'min_total', missingKop: 47_200 });
    if (!result.ok) {
      expect(plain(result.message)).toBe(
        'Минимальная сумма заказа 1 000 ₽ — добавьте позиции ещё на 472 ₽',
      );
    }
    expect(
      checkOrderMinimums({
        subtotalKop: 100_000,
        marginKop: 1,
        minOrderTotalKop: 100_000,
        minMarginKop: 0,
      }),
    ).toEqual({ ok: true });
  });

  it('never discloses the margin', () => {
    const result = checkOrderMinimums({
      subtotalKop: 52_800,
      marginKop: 11_550,
      minOrderTotalKop: 0,
      minMarginKop: 20_000,
    });
    expect(result).toEqual({
      ok: false,
      code: 'min_margin',
      message: 'Заказ слишком маленький для оформления на сайте — добавьте ещё позицию',
      missingKop: null,
    });
    expect(
      checkOrderMinimums({
        subtotalKop: 52_800,
        marginKop: 20_000,
        minOrderTotalKop: 0,
        minMarginKop: 20_000,
      }),
    ).toEqual({ ok: true });
  });

  it('an empty order and a negative margin never pass (as the guards)', () => {
    expect(
      checkOrderMinimums({ subtotalKop: 0, marginKop: 0, minOrderTotalKop: 0, minMarginKop: 0 }),
    ).toMatchObject({ ok: false, code: 'min_total' });
    expect(
      checkOrderMinimums({ subtotalKop: 100, marginKop: -1, minOrderTotalKop: 0, minMarginKop: 0 }),
    ).toMatchObject({ ok: false, code: 'min_margin' });
  });

  it('matches minTotalReached and minMarginReached', () => {
    for (const [subtotalKop, marginKop, minOrderTotalKop, minMarginKop] of [
      [100_000, 10, 100_000, 10],
      [99_999, 10, 100_000, 0],
      [100_000, 9, 0, 10],
      [1, 0, 0, 0],
    ] as const) {
      const ours = checkOrderMinimums({ subtotalKop, marginKop, minOrderTotalKop, minMarginKop });
      const machine = resolveTransition('draft', 'checkout', {
        actor: 'client',
        hasPdConsent: true,
        totalKop: subtotalKop,
        minOrderTotalKop,
        orderMarginKop: marginKop,
        minMarginKop,
        allItemsLocal: false,
        fulfillment: 'pickup',
      });
      expect(ours.ok).toBe(machine.ok);
    }
  });
});
