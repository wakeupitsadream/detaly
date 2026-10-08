// Step 2 (docs/pricing.md): without group adjustments every price stays exactly what it was
// before them. fixtures/pricing-golden.json was recorded on the Rossko fixtures with the code
// before group adjustments (search, cart lines, repricing, VIN preview, the demo order and
// proposal); this test runs the same paths now, through the settings readers of web and of the
// worker, and compares priceClientKop and markupBp one by one. A positive control checks that an
// adjustment moves exactly the offers of its group and stock kind.
import { readFileSync } from 'node:fs';
import { parseEnv } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import {
  applyMarkup,
  CartError,
  cartLineFromOffer,
  DEFAULT_EXCLUDED_RULES,
  priceGroupOf,
  PRICE_GROUPS,
  repriceCartLines,
  type CartLine,
  type MarkupRule,
  type Offer,
  type PricingConfig,
} from '@detaly/domain';
import { resolveOrderSettings } from '@detaly/orders';
import {
  createFixtureCaller,
  createRosskoClient,
  createUnlimitedLimiter,
  FIXTURE_LOCAL_STOCK_IDS,
} from '@detaly/rossko';
import { previewVinAnswer } from '@detaly/vin';
import { describe, expect, it } from 'vitest';
import { buildDemoOrderView } from '@/server/demo/order-fixture';
import { buildDemoProposal } from '@/server/demo/proposal-fixture';
import { createSearchService } from '@/server/search-service';
import { resolveSearchSettings, type SearchSettings } from '@/server/settings';

interface Golden {
  _meta: { now: string; articles: string[]; vinText: string; custom: MarkupRule[] };
  default: Snapshot;
  custom: Snapshot;
}
type Snapshot = Record<string, unknown>;

const GOLDEN = JSON.parse(
  readFileSync(new URL('./fixtures/pricing-golden.json', import.meta.url), 'utf8'),
) as Golden;
const NOW = new Date(GOLDEN._meta.now);
const env = parseEnv(minimalEnvSource());

function client() {
  return createRosskoClient({
    caller: createFixtureCaller(),
    key1: null,
    key2: null,
    localStockIds: FIXTURE_LOCAL_STOCK_IDS,
    limiter: createUnlimitedLimiter(),
    allowCheckout: false,
  });
}

/** The same computations as the recorder, with today's API. */
async function snapshot(settings: SearchSettings): Promise<Snapshot> {
  const ctx = {
    pricing: settings.pricing,
    excludedRules: settings.excludedRules,
    eta: settings.eta,
    now: NOW,
  };
  const svc = createSearchService({
    rossko: client(),
    limiter: createUnlimitedLimiter(),
    loadSettings: () => Promise.resolve(settings),
    now: () => NOW,
  });
  const search: Record<string, unknown> = {};
  const lines: Record<string, unknown> = {};
  const reprice: Record<string, unknown> = {};
  for (const article of GOLDEN._meta.articles) {
    const result = await svc.search({ q: article });
    search[article] = result.offers.map((o) => ({
      id: o.id,
      priceClientKop: o.priceClientKop,
      priceText: o.priceText,
      excluded: o.excluded,
    }));
    const { offers } = await client().search(article);
    const built: CartLine[] = [];
    lines[article] = offers.map((offer: Offer, i: number) => {
      try {
        const line = cartLineFromOffer(offer, article, Math.max(1, offer.stock.multiplicity), ctx);
        built.push({ ...line, id: `l${i}`, priceClientKop: line.priceClientKop - 100 });
        return {
          offerKey: line.offerKey,
          priceSupplierKop: line.priceSupplierKop,
          priceClientKop: line.priceClientKop,
          markupBp: line.markupBp,
        };
      } catch (error) {
        if (error instanceof CartError) return { offerKey: offer.articleNorm, error: error.code };
        throw error;
      }
    });
    const repriced = repriceCartLines(built, new Map([[article, offers]]), ctx);
    reprice[article] = {
      lines: repriced.lines.map((l) => ({
        offerKey: l.offerKey,
        status: l.status,
        priceClientKop: l.priceClientKop,
        markupBp: l.markupBp,
      })),
      changes: repriced.changes.map((c) => ({
        kind: c.kind,
        offerKey: c.offerKey,
        ...(c.kind === 'price' ? { newPriceKop: c.newPriceKop, deltaKop: c.deltaKop } : {}),
      })),
    };
  }
  const vin = await previewVinAnswer({
    text: GOLDEN._meta.vinText,
    search: async (a) => (await client().search(a)).offers,
    pricing: settings.pricing,
    excludedRules: settings.excludedRules,
    eta: settings.eta,
    now: NOW,
  });
  const demoOrder = await buildDemoOrderView({
    rossko: client(),
    loadSettings: () => Promise.resolve(settings),
    now: NOW,
  });
  const demoProposal = await buildDemoProposal({
    rossko: client(),
    loadSettings: () => Promise.resolve(settings),
    now: NOW,
  });
  return {
    search,
    lines,
    reprice,
    vin: {
      totalKop: vin.totalKop,
      lines: vin.lines.map((l) =>
        l.status === 'ok'
          ? {
              line: l.line,
              status: l.status,
              offerKey: l.offerKey,
              priceClientKop: l.priceClientKop,
              markupBp: l.markupBp,
            }
          : { line: l.line, status: l.status, reason: l.reason },
      ),
    },
    demoOrder: {
      totalKop: demoOrder.totalKop,
      items: demoOrder.items.map((i) => ({
        article: i.article,
        brand: i.brand,
        priceClientKop: i.priceClientKop,
      })),
    },
    demoProposal: demoProposal.lines.map((l) => ({
      offerKey: l.offerKey,
      priceClientKop: l.priceClientKop,
      markupBp: l.markupBp,
    })),
  };
}

function webSettings(rows: [string, unknown][]): SearchSettings {
  return {
    ...resolveSearchSettings(new Map(rows), env, [...DEFAULT_EXCLUDED_RULES]),
    fromDatabase: true,
  };
}

const ZERO_ADJUSTMENTS = PRICE_GROUPS.map((group) => ({ group, localDeltaBp: 0, orderDeltaBp: 0 }));

describe('without group adjustments prices are exactly the recorded ones', () => {
  it.each<[string, keyof Pick<Golden, 'default' | 'custom'>, [string, unknown][]]>([
    ['env defaults (no settings rows)', 'default', []],
    ['an empty adjustments row', 'default', [['pricing.group_adjustments', []]]],
    [
      'zero adjustments of every group',
      'default',
      [['pricing.group_adjustments', ZERO_ADJUSTMENTS]],
    ],
    [
      'a custom base table',
      'custom',
      [
        ['pricing.markup_rules', GOLDEN._meta.custom],
        ['pricing.group_adjustments', []],
      ],
    ],
    [
      'a custom base table and other bounds',
      'custom',
      [
        ['pricing.markup_rules', GOLDEN._meta.custom],
        ['pricing.min_markup_bp', 3000],
        ['pricing.max_markup_bp', 3500],
      ],
    ],
  ])('%s', async (_name, table, rows) => {
    expect(await snapshot(webSettings(rows))).toEqual(GOLDEN[table]);
  });

  it('the golden file covers search, cart lines, repricing, VIN preview and the demo', () => {
    const golden = GOLDEN.default as {
      search: Record<string, unknown[]>;
      vin: { lines: unknown[] };
      demoProposal: unknown[];
    };
    expect(golden.search.OC90?.length).toBeGreaterThan(3);
    expect(golden.search.GDB1330?.length).toBeGreaterThan(1);
    expect(golden.vin.lines.length).toBe(5);
    expect(golden.demoProposal.length).toBe(2);
  });
});

describe('web and the worker resolve the same PricingConfig', () => {
  it.each<[string, [string, unknown][]]>([
    ['defaults', []],
    [
      'adjustments, bounds and a margin floor',
      [
        ['pricing.group_adjustments', [{ group: 'filters', localDeltaBp: 300, orderDeltaBp: -50 }]],
        ['pricing.min_markup_bp', 1500],
        ['pricing.max_markup_bp', 5000],
        ['pricing.margin_floor_pct', 20],
      ],
    ],
    ['malformed rows', [['pricing.group_adjustments', 'oops']]],
  ])('%s', (_name, rows) => {
    const web: PricingConfig = webSettings(rows).pricing;
    const worker: PricingConfig = resolveOrderSettings(new Map(rows), env).pricing;
    expect(worker).toEqual(web);
  });
});

describe('an adjustment moves only its group and stock kind', () => {
  it('filters in Orenburg +3 p.p.: those offers by the formula, everything else as recorded', async () => {
    const adjusted = await snapshot(
      webSettings([
        ['pricing.group_adjustments', [{ group: 'filters', localDeltaBp: 300, orderDeltaBp: 0 }]],
      ]),
    );
    const golden = GOLDEN.default as {
      lines: Record<
        string,
        {
          offerKey: string;
          priceSupplierKop?: number;
          priceClientKop?: number;
          markupBp?: number;
        }[]
      >;
    };
    const lines = adjusted.lines as typeof golden.lines;
    let moved = 0;
    for (const article of GOLDEN._meta.articles) {
      const { offers } = await client().search(article);
      (lines[article] ?? []).forEach((line, i) => {
        const before = golden.lines[article]?.[i];
        const offer = offers[i] as Offer;
        const isFilterHere =
          priceGroupOf({ productGroup: offer.group, name: offer.name }) === 'filters' &&
          offer.stock.isLocal;
        if (before?.markupBp === undefined) {
          expect(line).toEqual(before);
        } else if (isFilterHere) {
          moved += 1;
          expect(line).toEqual({
            ...before,
            markupBp: before.markupBp + 300,
            priceClientKop: applyMarkup(before.priceSupplierKop as number, before.markupBp + 300),
          });
        } else {
          expect(line).toEqual(before);
        }
      });
    }
    // Knecht OC 90 and MANN-FILTER W 712/75 from the Orenburg stock
    expect(moved).toBe(2);
    const knecht = (lines.OC90 ?? []).find((l) => l.offerKey === 'OC90:Knecht:ORB1');
    expect(knecht?.priceClientKop).toBe(54_100);
  });
});
