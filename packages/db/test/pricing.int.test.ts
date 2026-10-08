// Step 2 (docs/pricing.md): price_benchmarks and settings_audit constraints (migration 0006).
import { testDatabaseUrl } from '@detaly/config/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client';
import { priceBenchmarks, settingsAudit } from '../src/schema';
import { expectPgError } from './helpers';

const CHECK = '23514';

let db: Db;

beforeAll(() => {
  db = createDb(testDatabaseUrl(), { max: 4 });
});

afterAll(async () => {
  await db?.close();
});

type BenchmarkInsert = typeof priceBenchmarks.$inferInsert;

function benchmark(over: Partial<BenchmarkInsert> = {}): BenchmarkInsert {
  return {
    brand: 'Knecht',
    article: 'OC90',
    priceGroup: 'filters',
    competitor: 'emex',
    competitorPriceKop: 60_000,
    competitorDeliveryKop: 0,
    competitorEtaDays: 2,
    ourSupplierKop: 41_250,
    ourPriceKop: 52_800,
    ourIsLocal: true,
    ourEtaDays: 1,
    capturedBy: 'admin',
    ...over,
  };
}

describe('price_benchmarks', () => {
  it('stores a comparison with a uuid v7 id and the capture time', async () => {
    const [row] = await db.insert(priceBenchmarks).values(benchmark()).returning();
    expect(row?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(row?.capturedAt).toBeInstanceOf(Date);
    expect(row?.competitorDeliveryKop).toBe(0);
    await db.delete(priceBenchmarks).where(eq(priceBenchmarks.id, row!.id));
  });

  it('stores a comparison without our snapshot (nothing found)', async () => {
    const [row] = await db
      .insert(priceBenchmarks)
      .values(
        benchmark({
          ourSupplierKop: null,
          ourPriceKop: null,
          ourIsLocal: null,
          ourEtaDays: null,
          priceGroup: 'other',
        }),
      )
      .returning();
    expect(row?.ourPriceKop).toBeNull();
    await db.delete(priceBenchmarks).where(eq(priceBenchmarks.id, row!.id));
  });

  it.each<[string, Partial<BenchmarkInsert>, string]>([
    ['an article that is not normalized', { article: 'OC 90' }, 'price_benchmarks_article_check'],
    ['an empty brand', { brand: '  ' }, 'price_benchmarks_brand_check'],
    ['an unknown group', { priceGroup: 'tyres' }, 'price_benchmarks_price_group_check'],
    ['an unknown competitor', { competitor: 'ozon' }, 'price_benchmarks_competitor_check'],
    ['a zero price', { competitorPriceKop: 0 }, 'price_benchmarks_competitor_price_kop_check'],
    [
      'a negative delivery',
      { competitorDeliveryKop: -1 },
      'price_benchmarks_competitor_delivery_kop_check',
    ],
    [
      'a year of delivery',
      { competitorEtaDays: 400 },
      'price_benchmarks_competitor_eta_days_check',
    ],
    ['half a snapshot', { ourPriceKop: null }, 'price_benchmarks_our_snapshot_check'],
    ['a snapshot without a date', { ourEtaDays: null }, 'price_benchmarks_our_snapshot_check'],
    ['a long note', { note: 'x'.repeat(301) }, 'price_benchmarks_note_check'],
    ['nobody captured it', { capturedBy: ' ' }, 'price_benchmarks_captured_by_check'],
  ])('rejects %s', async (_name, over, constraint) => {
    await expectPgError(db.insert(priceBenchmarks).values(benchmark(over)), CHECK, constraint);
  });
});

describe('settings_audit', () => {
  it('keeps the old and the new jsonb value of a key', async () => {
    const [row] = await db
      .insert(settingsAudit)
      .values({
        key: 'pricing.group_adjustments',
        oldValue: [],
        newValue: [{ group: 'filters', localDeltaBp: 300, orderDeltaBp: 0 }],
        changedBy: 'admin',
      })
      .returning();
    expect(row?.oldValue).toEqual([]);
    expect(row?.newValue).toEqual([{ group: 'filters', localDeltaBp: 300, orderDeltaBp: 0 }]);
    expect(row?.changedAt).toBeInstanceOf(Date);
    await expectPgError(
      db.insert(settingsAudit).values({ key: 'k', newValue: 1, changedBy: '' }),
      CHECK,
      'settings_audit_changed_by_check',
    );
    await db.delete(settingsAudit).where(eq(settingsAudit.id, row!.id));
  });
});
