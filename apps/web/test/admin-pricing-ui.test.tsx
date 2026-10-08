// Step 2 (docs/pricing.md): the wording helpers and the server-rendered admin pages /admin/prices
// and /admin/pricing (plain forms, no client JavaScript).
import {
  basePricingConfig,
  benchmarkReport,
  DEFAULT_MAX_MARKUP_BP,
  type BenchmarkRecord,
  type MarkupRule,
  type PricingConfig,
} from '@detaly/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminPrices } from '@/components/admin/AdminPrices';
import { AdminPricing } from '@/components/admin/AdminPricing';
import {
  deltaInputValue,
  etaDiffText,
  hintText,
  rangeLabel,
  signedPercent,
  signedRub,
} from '@/components/admin/price-format';
import type { AdminPriceRow, AdminPricesData } from '@/server/admin/prices';
import { pricingExamples, parsePricingDraft, type AdminPricingData } from '@/server/admin/pricing';

const RULES: MarkupRule[] = [
  { fromKop: 0, toKop: 100_000, localBp: 2800, orderBp: 2800 },
  { fromKop: 100_000, toKop: 500_000, localBp: 2800, orderBp: 2800 },
  { fromKop: 500_000, toKop: null, localBp: 2800, orderBp: 2800 },
];
const CONFIG: PricingConfig = { ...basePricingConfig(RULES), minMarkupBp: 1112 };

function row(over: Partial<AdminPriceRow> & { id: string; article: string }): AdminPriceRow {
  const record: BenchmarkRecord = {
    priceGroup: 'filters',
    competitorPriceKop: 140_000,
    competitorDeliveryKop: 0,
    competitorEtaDays: 3,
    ourSupplierKop: 100_000,
    ourPriceKop: 128_000,
    ourIsLocal: true,
    ourEtaDays: 1,
  };
  return {
    ...record,
    brand: 'Knecht',
    competitor: 'emex',
    sourceUrl: null,
    note: null,
    capturedAt: new Date('2026-10-07T06:00:00Z'),
    capturedBy: 'admin',
    diff: { totalKop: 140_000, diffKop: -12_000, diffBp: -857 },
    ...over,
  };
}

const ROWS = [
  row({ id: 'r1', article: 'F1' }),
  row({ id: 'r2', article: 'F2', competitorPriceKop: 150_000 }),
  row({
    id: 'r3',
    article: 'F3',
    competitorPriceKop: 145_000,
    sourceUrl: 'https://emex.example/x',
  }),
  row({
    id: 'r4',
    article: 'B1',
    priceGroup: 'brakes',
    ourSupplierKop: null,
    ourPriceKop: null,
    ourIsLocal: null,
    ourEtaDays: null,
    diff: null,
  }),
];

describe('wording helpers', () => {
  it('signed money, percents and terms', () => {
    expect(signedRub(-4_200)).toBe('\u221242\u00a0₽');
    expect(signedRub(12_000)).toBe('+120\u00a0₽');
    expect(signedRub(0)).toBe('0\u00a0₽');
    expect(signedPercent(-1015)).toBe('\u221210,15%');
    expect(signedPercent(667)).toBe('+6,67%');
    expect(etaDiffText(-2)).toBe('мы быстрее на 2 дн.');
    expect(etaDiffText(0)).toBe('так же');
    expect(etaDiffText(1)).toBe('мы дольше на 1 дн.');
    expect(etaDiffText(null)).toBe('—');
  });

  it('hints in the founder’s words', () => {
    expect(hintText({ kind: 'raise', byBp: 300, newDeltaBp: 300 })).toBe(
      'можно поднять до +3 п.п.',
    );
    expect(hintText({ kind: 'lower', byBp: 150, newDeltaBp: -150 })).toBe(
      'стоит снизить на 1,5 п.п. (до \u22121,5)',
    );
    expect(hintText({ kind: 'keep', reason: 'slower' })).toBe(
      'мы дешевле, но везём дольше — оставить',
    );
    expect(hintText({ kind: 'few', needed: 3 })).toBe('мало данных: нужно от 3 позиций');
  });

  it('ranges of the base table and editor values', () => {
    expect(RULES.map(rangeLabel)).toEqual([
      'до 1\u00a0000\u00a0₽',
      '1\u00a0000 – 5\u00a0000\u00a0₽',
      'от 5\u00a0000\u00a0₽',
    ]);
    expect(deltaInputValue(0)).toBe('');
    expect(deltaInputValue(300)).toBe('+3');
    expect(deltaInputValue(-150)).toBe('\u22121,5');
  });
});

describe('/admin/prices', () => {
  const data: AdminPricesData = {
    rows: ROWS,
    truncated: false,
    report: benchmarkReport(ROWS, CONFIG),
    periodRecords: 4,
    periodCompared: 3,
    lastWeek: 4,
  };

  it('renders the form, the report with the hint and the list', () => {
    const html = renderToStaticMarkup(
      createElement(AdminPrices, {
        query: { group: null, days: 28 },
        data,
        pricing: CONFIG,
        done: 'Записано',
      }),
    );
    expect(html).toContain('data-testid="prices-form"');
    expect(html).toContain('action="/api/admin/prices"');
    for (const name of [
      'brand',
      'article',
      'competitor',
      'price',
      'delivery',
      'eta',
      'url',
      'note',
    ]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain('data-testid="admin-done"');
    expect(html).toContain('За 7 дней внесено: 4 из 20');
    // filters: median headroom 17 p.p. -> «можно поднять до +17 п.п.»
    expect(html).toMatch(/data-testid="report-row" data-group="filters"/);
    expect(html).toContain('можно поднять до +17 п.п.');
    expect(html).toContain('нет у поставщика');
    expect(html.match(/data-testid="price-row"/g)).toHaveLength(4);
    // the delete form carries the «подтверждаю» tick
    expect(html).toContain('name="confirm"');
    expect(html).toContain(`не выше потолка (${String(DEFAULT_MAX_MARKUP_BP / 100)}%)`);
  });
});

describe('/admin/pricing', () => {
  function pricingData(params: Record<string, string>): AdminPricingData {
    const draft = parsePricingDraft(params);
    const draftConfig =
      draft?.adjustments != null ? { ...CONFIG, groupAdjustments: draft.adjustments } : null;
    return {
      config: CONFIG,
      bounds: {
        configuredMinBp: 1000,
        marginFloorMarkupBp: 1112,
        minMarkupBp: 1112,
        maxMarkupBp: 6000,
      },
      marginFloorPct: 10,
      version: '2026-10-08T05:00:00.000Z',
      updatedAt: new Date('2026-10-08T05:00:00Z'),
      updatedBy: 'seed',
      report: benchmarkReport(ROWS, CONFIG),
      reportDays: 28,
      draft,
      draftConfig,
      examples: draftConfig ? pricingExamples(ROWS, CONFIG, draftConfig) : [],
      audit: [
        {
          id: 'a1',
          changedAt: new Date('2026-10-01T05:00:00Z'),
          changedBy: 'admin',
          oldValue: [],
          newValue: [{ group: 'filters', localDeltaBp: 300, orderDeltaBp: 0 }],
        },
      ],
    };
  }

  it('without a draft: the base table, the bounds, the editor and the audit; no save form', () => {
    const html = renderToStaticMarkup(
      createElement(AdminPricing, { data: pricingData({}), done: null }),
    );
    expect(html).toContain('data-testid="pricing-base"');
    expect(html).toContain('до 1\u00a0000\u00a0₽');
    expect(html).toContain('11,12%');
    expect(html).toContain('60%');
    expect(html.match(/data-testid="pricing-group"/g)).toHaveLength(13);
    expect(html).toContain('name="l_filters"');
    expect(html).toContain('name="o_other"');
    expect(html).not.toContain('data-testid="pricing-save"');
    expect(html).toContain('Фильтры +3 / 0');
  });

  it('with a draft: the changes, three examples and the save form with the tick', () => {
    const html = renderToStaticMarkup(
      createElement(AdminPricing, {
        data: pricingData({ draft: '1', l_filters: '+3' }),
        done: null,
      }),
    );
    expect(html).toContain('data-testid="pricing-preview"');
    expect(html.match(/data-testid="pricing-example"/g)).toHaveLength(3);
    // 1000 ₽ wholesale: 1280 ₽ now, 1310 ₽ at 31%
    expect(html).toContain('1\u00a0310\u00a0₽');
    expect(html).toContain('data-testid="pricing-save"');
    expect(html).toContain('name="lbp_filters" value="300"');
    expect(html).toContain('name="obp_filters" value="0"');
    expect(html).toContain('name="version" value="2026-10-08T05:00:00.000Z"');
    const tick = /<input[^>]*name="confirm"[^>]*>/.exec(html)?.[0] ?? '';
    expect(tick).toContain('type="checkbox"');
    expect(tick).toContain('required');
  });

  it('an invalid draft shows the field error and no preview', () => {
    const html = renderToStaticMarkup(
      createElement(AdminPricing, {
        data: pricingData({ draft: '1', l_filters: 'abc' }),
        done: null,
      }),
    );
    expect(html).toContain('data-testid="pricing-field-error"');
    expect(html).toContain('data-testid="pricing-draft-invalid"');
    expect(html).not.toContain('data-testid="pricing-preview"');
  });
});
