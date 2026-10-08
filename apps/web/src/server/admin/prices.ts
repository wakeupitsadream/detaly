/**
 * Read model of /admin/prices (step 2, docs/pricing.md): the internal price benchmark. The list
 * of recent comparisons (filter by group and period) and the report per group over the period
 * (benchmarkReport of @detaly/domain: medians, the share where we are cheaper, the hint for the
 * group adjustment). Competitor prices are internal: this page is behind Basic auth only.
 */
import { and, desc, gt, eq, priceBenchmarks, type Executor, type SQL } from '@detaly/db';
import {
  BENCHMARK_COMPETITORS,
  BENCHMARK_DEFAULT_DAYS,
  benchmarkDiff,
  benchmarkReport,
  isOneOf,
  PRICE_GROUPS,
  type BenchmarkCompetitor,
  type BenchmarkDiff,
  type BenchmarkGroupStats,
  type BenchmarkRecord,
  type PriceGroup,
  type PricingConfig,
} from '@detaly/domain';

/** Periods offered by the filter, days. */
export const PRICE_PERIODS = [7, 14, 28, 56, 90] as const;
/** Rows of the list (the report always uses the whole period). */
export const PRICE_LIST_LIMIT = 200;
/** A weekly check: the reminder of the worker stops at this many records in 7 days. */
export const PRICE_WEEK_TARGET = 20;

export const COMPETITOR_LABELS: Record<BenchmarkCompetitor, string> = {
  emex: 'Emex',
  exist: 'Exist',
  autodoc: 'Autodoc',
  rossko_retail: 'Rossko, розница',
  avito: 'Авито',
  other: 'Другое',
};

export interface AdminPricesQuery {
  group: PriceGroup | null;
  days: number;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export function parseAdminPricesQuery(
  params: Record<string, string | string[] | undefined>,
): AdminPricesQuery {
  const group = first(params.group);
  const days = Number.parseInt(first(params.days), 10);
  return {
    group: isOneOf(PRICE_GROUPS, group) ? group : null,
    days: (PRICE_PERIODS as readonly number[]).includes(days) ? days : BENCHMARK_DEFAULT_DAYS,
  };
}

/** `/admin/prices` with the filter (and an optional flash message). */
export function adminPricesHref(query: AdminPricesQuery, done?: string): string {
  const params = new URLSearchParams();
  if (query.group) params.set('group', query.group);
  if (query.days !== BENCHMARK_DEFAULT_DAYS) params.set('days', String(query.days));
  if (done) params.set('done', done.slice(0, 300));
  const text = params.toString();
  return text ? `/admin/prices?${text}` : '/admin/prices';
}

export interface AdminPriceRow extends BenchmarkRecord {
  id: string;
  brand: string;
  article: string;
  competitor: BenchmarkCompetitor;
  sourceUrl: string | null;
  note: string | null;
  capturedAt: Date;
  capturedBy: string;
  /** Our price against the competitor's total; null without our snapshot. */
  diff: BenchmarkDiff | null;
}

export interface AdminPricesData {
  rows: AdminPriceRow[];
  /** Rows of the period beyond PRICE_LIST_LIMIT were not listed. */
  truncated: boolean;
  report: BenchmarkGroupStats[];
  /** Records of the period (all groups) and of them with our price. */
  periodRecords: number;
  periodCompared: number;
  /** Records of the last 7 days (the weekly target). */
  lastWeek: number;
}

type Row = typeof priceBenchmarks.$inferSelect;

function toRecord(row: Row): AdminPriceRow {
  const record: BenchmarkRecord = {
    priceGroup: isOneOf(PRICE_GROUPS, row.priceGroup) ? row.priceGroup : 'other',
    competitorPriceKop: row.competitorPriceKop,
    competitorDeliveryKop: row.competitorDeliveryKop,
    competitorEtaDays: row.competitorEtaDays,
    ourSupplierKop: row.ourSupplierKop,
    ourPriceKop: row.ourPriceKop,
    ourIsLocal: row.ourIsLocal,
    ourEtaDays: row.ourEtaDays,
  };
  return {
    ...record,
    id: row.id,
    brand: row.brand,
    article: row.article,
    competitor: isOneOf(BENCHMARK_COMPETITORS, row.competitor) ? row.competitor : 'other',
    sourceUrl: row.sourceUrl,
    note: row.note,
    capturedAt: row.capturedAt,
    capturedBy: row.capturedBy,
    diff: benchmarkDiff(record),
  };
}

const DAY_MS = 86_400_000;

/** Records of the period, newest first. */
export async function loadBenchmarks(
  db: Executor,
  { since, group }: { since: Date; group?: PriceGroup | null },
): Promise<AdminPriceRow[]> {
  const conditions: SQL[] = [gt(priceBenchmarks.capturedAt, since)];
  if (group) conditions.push(eq(priceBenchmarks.priceGroup, group));
  const rows = await db
    .select()
    .from(priceBenchmarks)
    .where(and(...conditions))
    .orderBy(desc(priceBenchmarks.capturedAt), desc(priceBenchmarks.id));
  return rows.map(toRecord);
}

export async function loadAdminPrices(
  db: Executor,
  query: AdminPricesQuery,
  pricing: PricingConfig,
  now: Date,
): Promise<AdminPricesData> {
  const since = new Date(now.getTime() - query.days * DAY_MS);
  const period = await loadBenchmarks(db, { since });
  const weekAgo = now.getTime() - 7 * DAY_MS;
  const listed = query.group ? period.filter((row) => row.priceGroup === query.group) : period;
  return {
    rows: listed.slice(0, PRICE_LIST_LIMIT),
    truncated: listed.length > PRICE_LIST_LIMIT,
    report: benchmarkReport(period, pricing),
    periodRecords: period.length,
    periodCompared: period.filter((row) => row.diff !== null).length,
    lastWeek: period.filter((row) => row.capturedAt.getTime() > weekAgo).length,
  };
}
