// Step 7 (docs/month-close.md): the printable act of the pickup point (no split of money named,
// totals in figures, the parties from env, blank lines without them), the parsing of the month
// and of the rates editor, and the server-rendered rates editor with its preview.
import {
  buildAct,
  DEFAULT_CONTRACT_RATES,
  emptyActCounts,
  formatRub,
  monthBounds,
  type ActCounts,
  type ContractRates,
} from '@detaly/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminAct } from '@/components/admin/AdminAct';
import { AdminRates } from '@/components/admin/AdminRates';
import {
  actContractFromEnv,
  parseMonthParam,
  parsePercentToBp,
  parseRatesDraft,
  percentInputValue,
  postedMonth,
  ratesFromSaveForm,
  rubInputValue,
  type AdminRatesData,
} from '@/server/admin/month';

/** Whitespace as one space (the rendered text and the NBSP of formatRub alike). */
const norm = (text: string) => text.replace(/\s+/gu, ' ');

/** «прибыль» and «доля» in any form: the act never names a split of the seller's money. */
const FORBIDDEN = /прибыл|(?<![а-яё])дол(?:я|и|ю|ей|ям|ями|ях)(?![а-яё])/iu;

const COUNTS: ActCounts = {
  ...emptyActCounts(),
  receive: 12,
  store_day: 30,
  handover: 9,
  return_accept: 1,
  vin_selection: 3,
  fit_check: 4,
  claim_diagnostics: 1,
};

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
  turnoverBp: 150,
};

const FULL_ENV = {
  SELLER_REQUISITES_NAME: 'Тестов Тест Тестович',
  SELLER_REQUISITES_INN: '0'.repeat(12),
  SELLER_REQUISITES_OGRNIP: '1'.repeat(15),
  SELLER_REQUISITES_ADDRESS: 'г. Тестовск, ул. Пробная, 1',
  CONTRACTOR_REQUISITES_NAME: 'ИП Пунктов Пётр Петрович',
  CONTRACTOR_REQUISITES_INN: '2'.repeat(12),
  CONTRACTOR_REQUISITES_OGRNIP: '3'.repeat(15),
  CONTRACTOR_REQUISITES_ADDRESS: 'г. Тестовск, ул. Выдачи, 5',
  CONTRACT_NUMBER: '7/П',
  CONTRACT_DATE: '2026-08-01',
};

function renderAct(rates: ContractRates, env: Parameters<typeof actContractFromEnv>[0]) {
  const act = buildAct(COUNTS, rates, 1_234_500);
  const html = renderToStaticMarkup(
    createElement(AdminAct, {
      month: '2026-09',
      bounds: monthBounds('2026-09'),
      act,
      contract: actContractFromEnv(env),
    }),
  );
  return { act, html, text: html.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ') };
}

describe('the printable act', () => {
  it('numbers, dates, parties and the contract come from the month and env', () => {
    const { text } = renderAct(RATES, FULL_ENV);
    expect(text).toContain('Акт № 09/2026 от 30 сентября 2026 г.');
    expect(text).toContain('об оказании услуг по договору № 7/П от 1 августа 2026 г.');
    expect(text).toContain('Период: с 1 сентября 2026 г. по 30 сентября 2026 г.');
    expect(text).toContain(
      `Исполнитель: ИП Пунктов Пётр Петрович, ИНН ${'2'.repeat(12)}, ОГРНИП ${'3'.repeat(15)}, г. Тестовск, ул. Выдачи, 5`,
    );
    expect(text).toContain(
      `Заказчик: ИП Тестов Тест Тестович, ИНН ${'0'.repeat(12)}, ОГРНИП ${'1'.repeat(15)}, г. Тестовск, ул. Пробная, 1`,
    );
    // Signature lines with the initials.
    expect(text).toContain('/ Пунктов П. П. /');
    expect(text).toContain('/ Тестов Т. Т. /');
  });

  it('lists every service with quantity × price and the total in figures', () => {
    const { act, html, text } = renderAct(RATES, FULL_ENV);
    // 12×50 + 30×10 + 9×100 + 1×150 + 3×200 + 4×75 + 1×300 = 3 150 ₽; 1,5% of 12 345 ₽ = 185,18 ₽
    expect(act.totalKop).toBe(315_000 + 18_518);
    // Amounts of the table as figures with kopecks, the sum line in rubles.
    expect(html).toContain('data-testid="act-total">3\u00a0335,18<');
    expect(text).toContain('Приёмка детали от поставщика 12 шт. × 50,00 12 шт. 50,00 600,00');
    expect(text).toContain('Хранение заказа 30 сут. × 10,00 30 сут. 10,00 300,00');
    expect(text).toContain(
      norm(`Всего оказано услуг на сумму ${formatRub(333_518)} (операций за месяц: 60).`),
    );
    expect(text).toContain('Обработка заказов: 1,5% от стоимости выданных заказов');
    expect(text).not.toMatch(FORBIDDEN);
  });

  it('with zero rates still renders every operation with its count, total 0 ₽', () => {
    const { act, html, text } = renderAct(DEFAULT_CONTRACT_RATES, FULL_ENV);
    expect(act.ratesSet).toBe(false);
    expect(act.lines.map((line) => line.quantity)).toEqual([12, 30, 9, 1, 3, 4, 1]);
    expect(html).toContain('data-testid="act-total">0,00<');
    // The «Ставки не заданы» warning belongs to the screen, never to the printed act.
    expect(text).not.toContain('Ставки не заданы');
    expect(text).not.toMatch(FORBIDDEN);
  });

  it('without requisites prints blank lines to fill in by hand', () => {
    const contract = actContractFromEnv({});
    expect(contract.missing).toEqual([
      'SELLER_REQUISITES_NAME',
      'SELLER_REQUISITES_INN',
      'CONTRACTOR_REQUISITES_NAME',
      'CONTRACTOR_REQUISITES_INN',
      'CONTRACT_NUMBER',
    ]);
    const { text } = renderAct(RATES, {});
    expect(text).toContain('по договору № ______ от «___» ____________ 20__ г.');
    expect(text).toContain('Исполнитель: ____________________, ИНН ____________');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('labels a company registration number as ОГРН', () => {
    const contract = actContractFromEnv({
      CONTRACTOR_REQUISITES_NAME: 'ООО «Пункт»',
      CONTRACTOR_REQUISITES_OGRNIP: '4'.repeat(13),
    });
    expect(contract.contractor.ogrn).toEqual({ label: 'ОГРН', value: '4'.repeat(13) });
  });
});

describe('month and rates parsing', () => {
  const now = new Date('2026-10-09T06:00:00Z');

  it('the month of the page: previous by default, never in the future', () => {
    expect(parseMonthParam(undefined, now)).toBe('2026-09');
    expect(parseMonthParam('2026-10', now)).toBe('2026-10');
    expect(parseMonthParam('2026-03', now)).toBe('2026-03');
    expect(parseMonthParam(['2025-12', '2026-01'], now)).toBe('2025-12');
    for (const bad of ['2026-11', '2026-13', '2026-1', '1999-01', 'x', '']) {
      expect(parseMonthParam(bad, now), bad).toBe('2026-09');
    }
    expect(postedMonth('2026-08', now)).toBe('2026-08');
    expect(postedMonth('2027-01', now)).toBeNull();
  });

  it('rubles and percents of the inputs', () => {
    expect(rubInputValue(15_000)).toBe('150');
    expect(rubInputValue(15_050)).toBe('150,50');
    expect(percentInputValue(150)).toBe('1,5');
    expect(percentInputValue(105)).toBe('1,05');
    expect(percentInputValue(300)).toBe('3');
    expect(parsePercentToBp('1,5')).toBe(150);
    expect(parsePercentToBp('0.25')).toBe(25);
    expect(parsePercentToBp('')).toBe(0);
    expect(parsePercentToBp('1,234')).toBeNull();
    expect(parsePercentToBp('-1')).toBeNull();
  });

  it('the GET draft: typed values, errors, storage left out', () => {
    const draft = parseRatesDraft({
      draft: '1',
      rate_receive: '50',
      rate_store_day: '10',
      rate_handover: '100,5',
      rate_return_accept: '',
      rate_vin_selection: '200',
      rate_fit_check: '75',
      rate_claim_diagnostics: '300',
      turnover: '1,5',
    });
    expect(draft?.storage).toBe(false);
    expect(draft?.rates).toEqual({
      perOperationKop: {
        receive: 5_000,
        handover: 10_050,
        return_accept: 0,
        vin_selection: 20_000,
        fit_check: 7_500,
        claim_diagnostics: 30_000,
      },
      turnoverBp: 150,
    });
    const bad = parseRatesDraft({
      draft: '1',
      storage: 'on',
      rate_store_day: 'abc',
      turnover: '101',
    });
    expect(bad?.rates).toBeNull();
    expect(bad?.fields.rate_store_day?.error).toBeTruthy();
    expect(bad?.fields.turnover?.error).toBeTruthy();
    expect(parseRatesDraft({})).toBeNull();
  });

  it('the save form: integers only, within the limits', () => {
    const form = new URLSearchParams({
      storage: 'on',
      kop_receive: '5000',
      kop_store_day: '1000',
      kop_handover: '10000',
      kop_return_accept: '15000',
      kop_vin_selection: '20000',
      kop_fit_check: '7500',
      kop_claim_diagnostics: '30000',
      turnover_bp: '150',
    });
    expect(ratesFromSaveForm(form)).toEqual(RATES);
    form.delete('storage');
    expect(ratesFromSaveForm(form)?.perOperationKop.store_day).toBeUndefined();
    form.set('kop_receive', '-1');
    expect(ratesFromSaveForm(form)).toBeNull();
    form.set('kop_receive', '5000');
    form.set('turnover_bp', '10001');
    expect(ratesFromSaveForm(form)).toBeNull();
  });
});

describe('the rates editor', () => {
  function data(over: Partial<AdminRatesData> = {}): AdminRatesData {
    const current = buildAct(COUNTS, DEFAULT_CONTRACT_RATES, 1_234_500);
    return {
      month: '2026-09',
      rates: DEFAULT_CONTRACT_RATES,
      version: '2026-10-01T00:00:00.000Z',
      updatedAt: null,
      updatedBy: null,
      draft: null,
      current,
      preview: null,
      ...over,
    };
  }

  it('without a draft: the inputs, the act at the current rates and the warning', () => {
    const html = renderToStaticMarkup(createElement(AdminRates, { data: data(), done: null }));
    expect(html).toContain('name="rate_receive"');
    expect(html).toContain('name="turnover"');
    expect(html).toContain('Ставки не заданы');
    expect(html).toContain(`data-testid="rates-total-now">${formatRub(0)}<`);
    expect(html).not.toContain('data-testid="rates-save"');
  });

  it('with a valid draft: the act before and after, the save form behind the tick', () => {
    const params = {
      draft: '1',
      storage: 'on',
      rate_receive: '50',
      rate_store_day: '10',
      rate_handover: '100',
      rate_return_accept: '150',
      rate_vin_selection: '200',
      rate_fit_check: '75',
      rate_claim_diagnostics: '300',
      turnover: '1,5',
    };
    const draft = parseRatesDraft(params);
    const html = renderToStaticMarkup(
      createElement(AdminRates, {
        data: data({ draft, preview: buildAct(COUNTS, draft!.rates!, 1_234_500) }),
        done: null,
      }),
    );
    expect(html).toContain(`data-testid="rates-total-draft">${formatRub(333_518)}<`);
    expect(html).toContain('data-testid="rates-save"');
    expect(html).toContain('name="kop_receive" value="5000"');
    expect(html).toContain('name="turnover_bp" value="150"');
    expect(html).toContain('name="version" value="2026-10-01T00:00:00.000Z"');
    expect(html).toContain('name="confirm"');
    expect(html).not.toMatch(FORBIDDEN);
  });
});
