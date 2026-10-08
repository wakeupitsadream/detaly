// Step 2 (docs/pricing.md): the internal price benchmark and the audit of money settings.
import { BENCHMARK_COMPETITORS, PRICE_GROUPS } from '@detaly/domain/statuses';
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { id, kop, kopCheck, namedCheck, sqlList, tstz } from './columns';

/**
 * One comparison of a part at a competitor with our own best exact offer at that moment,
 * entered by hand on /admin/prices (weekly, 20–30 popular parts). Internal data for the group
 * adjustments of the markup: never shown to clients. Our side is a snapshot (null when the
 * search found no exact offer): all four `our_*` columns are set together.
 */
export const priceBenchmarks = pgTable(
  'price_benchmarks',
  {
    id: id(),
    brand: text().notNull(),
    /** Normalized article: upper case [A-Z0-9] (normalizeArticle). */
    article: text().notNull(),
    /** PRICE_GROUPS: of our offer (priceGroupOf), or chosen by hand when there is none. */
    priceGroup: text().notNull(),
    /** BENCHMARK_COMPETITORS. */
    competitor: text().notNull(),
    competitorPriceKop: kop().notNull(),
    /** Delivery to Orenburg; 0 for pickup. */
    competitorDeliveryKop: kop().notNull().default(0),
    competitorEtaDays: integer(),
    sourceUrl: text(),
    note: text(),
    /** Supplier price of our best exact offer when recorded. */
    ourSupplierKop: kop(),
    /** Our client price of that offer (priceOffer with the settings of that moment). */
    ourPriceKop: kop(),
    ourIsLocal: boolean(),
    /** Days from the recording day to the date we promised the client. */
    ourEtaDays: integer(),
    capturedAt: tstz().notNull().defaultNow(),
    /** 'admin' (the Basic auth account) or a staff id. */
    capturedBy: text().notNull(),
  },
  (t) => [
    index('price_benchmarks_captured_at_idx').on(t.capturedAt),
    index('price_benchmarks_price_group_captured_at_idx').on(t.priceGroup, t.capturedAt),
    namedCheck('price_benchmarks', 'article', sql`${t.article} ~ '^[A-Z0-9]{1,64}$'`),
    namedCheck('price_benchmarks', 'brand', sql`length(btrim(${t.brand})) between 1 and 64`),
    namedCheck(
      'price_benchmarks',
      'price_group',
      sql`${t.priceGroup} in (${sqlList(PRICE_GROUPS)})`,
    ),
    namedCheck(
      'price_benchmarks',
      'competitor',
      sql`${t.competitor} in (${sqlList(BENCHMARK_COMPETITORS)})`,
    ),
    namedCheck('price_benchmarks', 'competitor_price_kop', sql`${t.competitorPriceKop} > 0`),
    kopCheck('price_benchmarks', 'competitor_delivery_kop', t.competitorDeliveryKop),
    namedCheck(
      'price_benchmarks',
      'competitor_eta_days',
      sql`${t.competitorEtaDays} is null or ${t.competitorEtaDays} between 0 and 365`,
    ),
    namedCheck(
      'price_benchmarks',
      'our_snapshot',
      // `is not null` spelled out: a comparison with NULL is NULL, which a CHECK lets through.
      sql`(${t.ourSupplierKop} is null and ${t.ourPriceKop} is null and ${t.ourIsLocal} is null and ${t.ourEtaDays} is null) or (${t.ourSupplierKop} is not null and ${t.ourPriceKop} is not null and ${t.ourIsLocal} is not null and ${t.ourEtaDays} is not null and ${t.ourSupplierKop} > 0 and ${t.ourPriceKop} > 0 and ${t.ourEtaDays} >= 0)`,
    ),
    namedCheck(
      'price_benchmarks',
      'source_url',
      sql`${t.sourceUrl} is null or length(${t.sourceUrl}) <= 500`,
    ),
    namedCheck('price_benchmarks', 'note', sql`${t.note} is null or length(${t.note}) <= 300`),
    namedCheck('price_benchmarks', 'captured_by', sql`length(btrim(${t.capturedBy})) > 0`),
  ],
);

/**
 * Every change of a money setting made by a person (group adjustments today): the old and the
 * new value, who and when. Written in the transaction that updates `settings`.
 */
export const settingsAudit = pgTable(
  'settings_audit',
  {
    id: id(),
    key: text().notNull(),
    /** null when the key had no row yet. */
    oldValue: jsonb(),
    newValue: jsonb().notNull(),
    /** 'admin' (the Basic auth account) or a staff id, as settings.updated_by. */
    changedBy: text().notNull(),
    changedAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    index('settings_audit_key_changed_at_idx').on(t.key, t.changedAt),
    namedCheck('settings_audit', 'changed_by', sql`length(btrim(${t.changedBy})) > 0`),
  ],
);
