// Step 7 (docs/month-close.md): month boundaries across the time zone, the act lines and totals
// with zero and non-zero rates, the margin estimate, the reconciliation diff, storage days and
// the finance settings. Integers only.
import { describe, expect, it } from 'vitest';
import {
  ACT_OPERATION_TITLES,
  ACT_OPERATIONS,
  actCsv,
  actOperationCount,
  actNumber,
  acquiringEstimateKop,
  addMonths,
  buildAct,
  contractRatesSet,
  countActFacts,
  DEFAULT_CONTRACT_RATES,
  DEFAULT_FINANCE_REMINDER_DAYS,
  diffByIds,
  emptyActCounts,
  financeReminderText,
  formatLongDate,
  formatRubSigned,
  inMonth,
  isMonthKey,
  marginReport,
  monthBounds,
  monthCloseFallbackText,
  monthCloseText,
  monthGenitive,
  monthKeyOf,
  monthTitle,
  parseAcquiringBp,
  parseContractRates,
  parseFinanceReminderDays,
  percentOfKop,
  previousMonth,
  sameContractRates,
  splitProportionally,
  storageDays,
  storageDaysInMonth,
  zonedDayStart,
  type ActFact,
  type ContractRates,
  type MarginLine,
} from '../src';

/** Words of a profit split: the act of a services contract never says them. */
const FORBIDDEN = /прибыл|(?<![а-яё])дол(?:я|и|ю|ей|ям|ями|ях)(?![а-яё])/iu;

const RATES: ContractRates = {
  perOperationKop: {
    receive: 5_000,
    store_day: 1_000,
    handover: 10_000,
    return_accept: 15_000,
    vin_selection: 20_000,
    fit_check: 7_500,
    claim_diagnostics: 30_000,
  },
  turnoverBp: 250,
};

describe('months in Asia/Yekaterinburg (UTC+5)', () => {
  it('a month starts at 19:00 UTC of the last day of the previous one', () => {
    const october = monthBounds('2026-10');
    expect(october.start.toISOString()).toBe('2026-09-30T19:00:00.000Z');
    expect(october.end.toISOString()).toBe('2026-10-31T19:00:00.000Z');
    expect(october.firstDay).toBe('2026-10-01');
    expect(october.lastDay).toBe('2026-10-31');
    // 23:59:59 local of 30 September is September; 00:00 local of 1 October is October.
    expect(monthKeyOf(new Date('2026-09-30T18:59:59.999Z'))).toBe('2026-09');
    expect(monthKeyOf(new Date('2026-09-30T19:00:00.000Z'))).toBe('2026-10');
    expect(inMonth(new Date('2026-09-30T18:59:59.999Z'), october)).toBe(false);
    expect(inMonth(new Date('2026-09-30T19:00:00.000Z'), october)).toBe(true);
    expect(inMonth(new Date('2026-10-31T18:59:59.999Z'), october)).toBe(true);
    expect(inMonth(new Date('2026-10-31T19:00:00.000Z'), october)).toBe(false);
    // The same instant is still September in Moscow (UTC+3).
    expect(monthKeyOf(new Date('2026-09-30T20:00:00.000Z'), 'Europe/Moscow')).toBe('2026-09');
  });

  it('crosses the year and knows February', () => {
    const december = monthBounds('2026-12');
    expect(december.end.toISOString()).toBe('2026-12-31T19:00:00.000Z');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
    expect(addMonths('2026-10', -10)).toBe('2025-12');
    expect(monthBounds('2028-02').lastDay).toBe('2028-02-29');
    expect(monthBounds('2027-02').lastDay).toBe('2027-02-28');
  });

  it('the previous month is the local one: 00:30 of the 1st closes the month before', () => {
    // 1 October 00:30 in Orenburg is still 30 September in UTC.
    expect(previousMonth(new Date('2026-09-30T19:30:00.000Z'))).toBe('2026-09');
    expect(previousMonth(new Date('2026-09-30T18:30:00.000Z'))).toBe('2026-08');
    expect(previousMonth(new Date('2027-01-01T10:00:00.000Z'))).toBe('2026-12');
  });

  it('day starts next to a daylight saving change are exact', () => {
    expect(zonedDayStart('2026-03-29', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-28T23:00:00.000Z',
    );
    expect(zonedDayStart('2026-03-30', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T22:00:00.000Z',
    );
    expect(zonedDayStart('2026-10-26', 'Europe/Berlin').toISOString()).toBe(
      '2026-10-25T23:00:00.000Z',
    );
  });

  it('accepts only YYYY-MM of this century', () => {
    expect(isMonthKey('2026-09')).toBe(true);
    for (const bad of ['2026-13', '2026-9', '26-09', '1999-12', '2100-01', '', null, 202609]) {
      expect(isMonthKey(bad)).toBe(false);
    }
    expect(() => monthBounds('2026-13')).toThrow();
  });

  it('words of the month', () => {
    expect(monthTitle('2026-09')).toBe('сентябрь 2026');
    expect(monthGenitive('2026-09')).toBe('сентября 2026');
    expect(formatLongDate('2026-09-30')).toBe('30 сентября 2026 г.');
    expect(actNumber('2026-09')).toBe('09/2026');
  });
});

describe('the act', () => {
  const counts = {
    ...emptyActCounts(),
    receive: 12,
    store_day: 30,
    handover: 9,
    return_accept: 1,
    vin_selection: 4,
    fit_check: 6,
    claim_diagnostics: 2,
  };

  it('with zero rates: every operation with its count, nothing to pay, «not set»', () => {
    const act = buildAct(counts, DEFAULT_CONTRACT_RATES, 1_234_500);
    expect(act.ratesSet).toBe(false);
    expect(act.totalKop).toBe(0);
    expect(act.lines.map((line) => [line.key, line.quantity, line.rateKop, line.sumKop])).toEqual(
      ACT_OPERATIONS.map((operation) => [operation, counts[operation], 0, 0]),
    );
    // No turnover rate: no turnover line; its base is still reported.
    expect(act.turnoverBaseKop).toBe(1_234_500);
  });

  it('with rates: count × rate per line, the turnover fee rounded half up, the total', () => {
    const act = buildAct(counts, RATES, 1_234_500);
    expect(act.ratesSet).toBe(true);
    const sums = Object.fromEntries(act.lines.map((line) => [line.key, line.sumKop]));
    expect(sums).toEqual({
      receive: 60_000,
      store_day: 30_000,
      handover: 90_000,
      return_accept: 15_000,
      vin_selection: 80_000,
      fit_check: 45_000,
      claim_diagnostics: 60_000,
      // 12 345 ₽ × 2.5 % = 308.625 ₽ -> 308.63 ₽
      turnover: 30_863,
    });
    expect(act.totalKop).toBe(
      60_000 + 30_000 + 90_000 + 15_000 + 80_000 + 45_000 + 60_000 + 30_863,
    );
    const turnover = act.lines.at(-1);
    expect(turnover).toMatchObject({ key: 'turnover', quantity: 1, unit: 'усл.' });
    expect(turnover?.title).toBe(
      'Обработка заказов: 2,5% от стоимости выданных заказов (12 345 ₽)',
    );
  });

  it('storage left out of the contract: no storage line', () => {
    const { store_day: _storage, ...withoutStorage } = RATES.perOperationKop;
    const act = buildAct(counts, { perOperationKop: withoutStorage, turnoverBp: 0 }, 0);
    expect(act.lines.map((line) => line.key)).not.toContain('store_day');
    expect(act.lines).toHaveLength(ACT_OPERATIONS.length - 1);
  });

  it('never names a profit split', () => {
    const act = buildAct(counts, RATES, 1_234_500);
    for (const line of act.lines) expect(line.title).not.toMatch(FORBIDDEN);
    for (const { title, unit } of Object.values(ACT_OPERATION_TITLES)) {
      expect(`${title} ${unit}`).not.toMatch(FORBIDDEN);
    }
    // The check itself catches the words.
    expect('доля прибыли').toMatch(FORBIDDEN);
    expect('Доли').toMatch(FORBIDDEN);
    expect('подбор, долгий срок, доллар').not.toMatch(FORBIDDEN);
  });

  it('counts facts and writes the CSV: date, order, service, rate', () => {
    const facts: ActFact[] = [
      {
        operation: 'handover',
        at: new Date('2026-09-10T09:05:00.000Z'),
        orderNumber: 'DT-000012',
        ref: null,
      },
      {
        operation: 'receive',
        at: new Date('2026-09-08T04:00:00.000Z'),
        orderNumber: 'DT-000012',
        ref: null,
      },
      {
        operation: 'store_day',
        at: zonedDayStart('2026-09-08'),
        orderNumber: 'DT-000012',
        ref: null,
      },
      {
        operation: 'vin_selection',
        at: new Date('2026-09-09T06:30:00.000Z'),
        orderNumber: null,
        ref: 'VIN 0192a3b4',
      },
    ];
    expect(countActFacts(facts)).toEqual({
      ...emptyActCounts(),
      receive: 1,
      store_day: 1,
      handover: 1,
      vin_selection: 1,
    });
    expect(actCsv(facts, RATES)).toBe(
      [
        'Дата;Заказ;Операция;Ставка, ₽',
        '08.09.2026;DT-000012;Хранение заказа;10,00',
        '08.09.2026 09:00;DT-000012;Приёмка детали от поставщика;50,00',
        '09.09.2026 11:30;VIN 0192a3b4;Подбор запчастей по VIN;200,00',
        '10.09.2026 14:05;DT-000012;Выдача заказа покупателю;100,00',
        '',
      ].join('\r\n'),
    );
    expect(actOperationCount(countActFacts(facts), RATES)).toBe(4);

    // Storage left out of the contract: neither a CSV row nor an operation of the act.
    const { store_day: _storage, ...noStorage } = RATES.perOperationKop;
    const withoutStorage = { perOperationKop: noStorage, turnoverBp: 0 };
    expect(actCsv(facts, withoutStorage)).not.toContain('Хранение заказа');
    expect(actCsv(facts, withoutStorage).split('\r\n')).toHaveLength(5);
    expect(actOperationCount(countActFacts(facts), withoutStorage)).toBe(3);
  });

  it('percentOfKop rounds half up', () => {
    expect(percentOfKop(100, 50)).toBe(1); // 0.5 kop -> 1
    expect(percentOfKop(99, 50)).toBe(0); // 0.495 -> 0
    expect(percentOfKop(1_000_000, 280)).toBe(28_000);
    expect(() => percentOfKop(-1, 280)).toThrow();
  });
});

describe('contract rates and finance settings', () => {
  it('parses the stored rates in normal form and refuses anything else', () => {
    expect(parseContractRates(DEFAULT_CONTRACT_RATES)).toEqual(DEFAULT_CONTRACT_RATES);
    expect(contractRatesSet(DEFAULT_CONTRACT_RATES)).toBe(false);
    expect(contractRatesSet(RATES)).toBe(true);
    expect(contractRatesSet({ ...DEFAULT_CONTRACT_RATES, turnoverBp: 1 })).toBe(true);
    const { store_day: _storage, ...noStorage } = RATES.perOperationKop;
    expect(parseContractRates({ perOperationKop: noStorage, turnoverBp: 0 })).toEqual({
      perOperationKop: noStorage,
      turnoverBp: 0,
    });
    for (const bad of [
      null,
      [],
      { perOperationKop: { ...RATES.perOperationKop, receive: -1 }, turnoverBp: 0 },
      { perOperationKop: { ...RATES.perOperationKop, receive: 1.5 }, turnoverBp: 0 },
      { perOperationKop: { ...RATES.perOperationKop, extra: 1 }, turnoverBp: 0 },
      { perOperationKop: { ...noStorage, handover: undefined }, turnoverBp: 0 },
      { perOperationKop: RATES.perOperationKop, turnoverBp: 10_001 },
      { perOperationKop: RATES.perOperationKop },
    ]) {
      expect(parseContractRates(bad)).toBeNull();
    }
    expect(sameContractRates(RATES, { ...RATES })).toBe(true);
    expect(sameContractRates(RATES, DEFAULT_CONTRACT_RATES)).toBe(false);
  });

  it('acquiring estimate and the reminder days', () => {
    expect(parseAcquiringBp(280)).toBe(280);
    expect(parseAcquiringBp(0)).toBe(0);
    for (const bad of [-1, 2.5, 2001, '280', null]) expect(parseAcquiringBp(bad)).toBeNull();
    expect(parseFinanceReminderDays(DEFAULT_FINANCE_REMINDER_DAYS)).toEqual({
      act: 3,
      bank_check: 5,
      tax: 25,
    });
    for (const bad of [
      { act: 0, bank_check: 5, tax: 25 },
      { act: 3, bank_check: 5, tax: 29 },
      { act: 3, bank_check: 5 },
      { act: 3, bank_check: 5, tax: 25, other: 1 },
      'x',
    ]) {
      expect(parseFinanceReminderDays(bad)).toBeNull();
    }
  });
});

describe('storage days', () => {
  it('counts the nights at the point inside the month', () => {
    // arrived 28 September, handed 3 October: 3 nights in September, 2 in October
    expect(storageDaysInMonth('2026-09-28', '2026-10-03', '2026-09')).toBe(3);
    expect(storageDaysInMonth('2026-09-28', '2026-10-03', '2026-10')).toBe(2);
    expect(storageDays('2026-09-28', '2026-10-03', '2026-10')).toEqual([
      '2026-10-01',
      '2026-10-02',
    ]);
    // handed the day it arrived: no storage
    expect(storageDaysInMonth('2026-09-28', '2026-09-28', '2026-09')).toBe(0);
    // still at the point: to the end of the month
    expect(storageDaysInMonth('2026-09-25', null, '2026-09')).toBe(6);
    // outside the month
    expect(storageDaysInMonth('2026-08-01', '2026-08-05', '2026-09')).toBe(0);
  });
});

describe('margin', () => {
  const line = (over: Partial<MarginLine>): MarginLine => ({
    orderId: 'o1',
    orderNumber: 'DT-000001',
    group: 'filters',
    revenueKop: 105_600,
    purchaseKop: 82_500,
    deliveryKop: 0,
    ...over,
  });

  it('per item: client price − order price − acquiring estimate − delivery share', () => {
    // 1 056 ₽ × 2.8 % = 29.568 ₽ -> 29.57 ₽
    expect(acquiringEstimateKop(105_600, 280)).toBe(2_957);
    const report = marginReport([line({ deliveryKop: 1_000 })], 280);
    expect(report.totals).toEqual({
      items: 1,
      revenueKop: 105_600,
      purchaseKop: 82_500,
      acquiringKop: 2_957,
      deliveryKop: 1_000,
      marginKop: 105_600 - 82_500 - 2_957 - 1_000,
      marginBp: 1812, // 191.43 ₽ / 1 056 ₽ = 18.127…% rounded down
    });
  });

  it('by price group in the group order, orders below zero listed worst first', () => {
    const report = marginReport(
      [
        line({
          group: 'brakes',
          orderId: 'o2',
          orderNumber: 'DT-000002',
          revenueKop: 234_800,
          purchaseKop: 183_400,
        }),
        line({}),
        line({ orderId: 'o3', orderNumber: 'DT-000003', revenueKop: 50_000, purchaseKop: 60_000 }),
        line({
          group: 'other',
          orderId: 'o4',
          orderNumber: 'DT-000004',
          revenueKop: 10_000,
          purchaseKop: 9_900,
          deliveryKop: 500,
        }),
      ],
      280,
    );
    expect(report.groups.map((group) => [group.group, group.items])).toEqual([
      ['filters', 2],
      ['brakes', 1],
      ['other', 1],
    ]);
    expect(report.negativeOrders.map((order) => [order.orderNumber, order.marginKop])).toEqual([
      ['DT-000003', 50_000 - 60_000 - 1_400],
      ['DT-000004', 10_000 - 9_900 - 280 - 500],
    ]);
    const sum = report.groups.reduce((acc, group) => acc + group.marginKop, 0);
    expect(sum).toBe(report.totals.marginKop);
    expect(formatRubSigned(-123_450)).toBe('−1 234,50 ₽');
    expect(formatRubSigned(0)).toBe('0 ₽');
  });

  it('no revenue: no margin percent', () => {
    expect(marginReport([], 280).totals.marginBp).toBeNull();
  });

  it('splits a delivery cost exactly by weights', () => {
    expect(splitProportionally(1_000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(splitProportionally(100, [82_500, 183_400])).toEqual([31, 69]);
    expect(splitProportionally(5, [0, 0])).toEqual([3, 2]);
    expect(splitProportionally(0, [5, 7])).toEqual([0, 0]);
    expect(splitProportionally(7, [])).toEqual([]);
    for (const [total, weights] of [
      [99_999, [3, 7, 11, 13]],
      [1, [5, 5]],
      [12_345, [1_000, 0, 250]],
    ] as const) {
      const parts = splitProportionally(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe('reconciliation diff', () => {
  it('missing on either side, amount and status mismatches, sorted', () => {
    const result = diffByIds(
      [
        { id: 'p1', amountKop: 10_000, status: 'succeeded', label: 'DT-000001' },
        { id: 'p2', amountKop: 20_000, status: 'succeeded', label: 'DT-000002' },
        { id: 'p3', amountKop: 30_000, status: 'pending', label: 'DT-000003' },
        { id: 'p4', amountKop: 40_000, status: 'succeeded', label: 'DT-000004' },
        { id: 'p4', amountKop: 1, status: 'canceled', label: 'dup' },
      ],
      [
        { id: 'p1', amountKop: 10_000, status: 'succeeded' },
        { id: 'p2', amountKop: 21_000, status: 'canceled' },
        { id: 'p3', amountKop: 30_000, status: 'succeeded' },
        { id: 'x9', amountKop: 5_000, status: 'succeeded' },
      ],
    );
    expect(result.dbCount).toBe(4);
    expect(result.providerCount).toBe(4);
    expect(result.matched).toBe(1);
    expect(result.differences.map((d) => [d.kind, d.id, d.label])).toEqual([
      ['missing_in_db', 'x9', null],
      ['missing_at_provider', 'p4', 'DT-000004'],
      ['amount', 'p2', 'DT-000002'],
      ['status', 'p2', 'DT-000002'],
      ['status', 'p3', 'DT-000003'],
    ]);
    expect(result.differences[2]).toMatchObject({ dbAmountKop: 20_000, providerAmountKop: 21_000 });
    expect(result.differences[4]).toMatchObject({
      dbStatus: 'pending',
      providerStatus: 'succeeded',
    });
  });

  it('two equal lists: everything matched', () => {
    const list = [{ id: 'r1', amountKop: 500, status: 'succeeded' }];
    expect(diffByIds(list, list)).toEqual({
      dbCount: 1,
      providerCount: 1,
      matched: 1,
      differences: [],
    });
    expect(diffByIds([], [])).toEqual({
      dbCount: 0,
      providerCount: 0,
      matched: 0,
      differences: [],
    });
  });
});

describe('messages of the month', () => {
  it('the close message: revenue, margin, operations, the link; the fallback without money', () => {
    const url = 'https://shop.example/admin/month?m=2026-09';
    expect(
      monthCloseText({
        month: '2026-09',
        revenueKop: 12_345_600,
        marginKop: -50_000,
        marginBp: -40,
        operations: 57,
        url,
      }),
    ).toBe(
      'Закрытие сентября 2026: выручка по чекам 123 456 ₽, маржа −500 ₽ (−0,4%), операций для акта 57, расхождений с ЮKassa: проверить.\n' +
        `Отчёт: ${url}`,
    );
    const fallback = monthCloseFallbackText({ month: '2026-09', operations: 57, url });
    expect(fallback).toBe(
      `Закрытие сентября 2026: операций для акта 57. Отчёт месяца — в админке: ${url}`,
    );
    expect(fallback).not.toMatch(/₽|маржа|выручка/u);
  });

  it('the reminders are neutral: where to look, the one confirmed deadline', () => {
    const input = { month: '2026-09', baseUrl: 'https://shop.example/' };
    expect(financeReminderText('act', input)).toBe(
      'Акт для пункта выдачи за сентябрь 2026: проверьте операции и распечатайте — https://shop.example/admin/month/act?m=2026-09',
    );
    expect(financeReminderText('bank_check', input)).toBe(
      'Сверьте операции в интернет-банке за сентябрь 2026. Список для сверки — https://shop.example/admin/month?m=2026-09',
    );
    expect(financeReminderText('tax', input)).toBe(
      'Срок уплаты налога АУСН — до 25-го (за сентябрь 2026).',
    );
    for (const kind of ['act', 'bank_check', 'tax'] as const) {
      expect(financeReminderText(kind, input)).not.toMatch(/₽|\d+,\d\d/u);
    }
  });
});
