/**
 * Read model of /admin/pricing (step 2, docs/pricing.md): the base markup table (view only),
 * the floor and the ceiling of adjustments, the editor of group adjustments with a preview on
 * three recent comparisons, the hint of the benchmark per group and the audit of past changes.
 * The draft travels in the GET query (`l_<group>` / `o_<group>`, percentage points as typed);
 * saving is a POST of the draft in bp with a «подтверждаю» tick (pricing-handler.ts).
 */
import { pctToBp, settingsDefaultsFromEnv, type Env } from '@detaly/config';
import { desc, eq, inArray, settings, settingsAudit, type Executor } from '@detaly/db';
import {
  BENCHMARK_DEFAULT_DAYS,
  benchmarkReport,
  competitorTotalKop,
  groupAdjustmentOf,
  MAX_GROUP_DELTA_BP,
  normalizeGroupAdjustments,
  parseGroupAdjustments,
  parsePercentPoints,
  priceFor,
  PRICE_GROUPS,
  resolvePricingBounds,
  resolvePricingConfig,
  type BenchmarkGroupStats,
  type GroupAdjustment,
  type OfferPrice,
  type PriceGroup,
  type PricingBounds,
  type PricingConfig,
} from '@detaly/domain';
import { loadBenchmarks, type AdminPriceRow } from './prices';

export const ADJUSTMENTS_KEY = 'pricing.group_adjustments';
/** Who edits settings from the admin (one Basic auth account, decision Б19). */
export const ADMIN_ACTOR = 'admin';
/** Positions of the preview. */
export const PREVIEW_EXAMPLES = 3;
/** Audit rows shown under the editor. */
export const AUDIT_ROWS = 10;

const PRICING_KEYS = [
  'pricing.markup_rules',
  ADJUSTMENTS_KEY,
  'pricing.min_markup_bp',
  'pricing.max_markup_bp',
  'pricing.margin_floor_pct',
] as const;

/** Form field names of a group in the editor (percentage points) and the save form (bp). */
export function draftField(side: 'local' | 'order', group: PriceGroup): string {
  return `${side === 'local' ? 'l' : 'o'}_${group}`;
}
export function bpField(side: 'local' | 'order', group: PriceGroup): string {
  return `${side === 'local' ? 'lbp' : 'obp'}_${group}`;
}

/** settings.updated_at of the adjustments row as the optimistic version of the editor. */
export function adjustmentsVersion(row: { updatedAt: Date } | null | undefined): string {
  return row ? row.updatedAt.toISOString() : 'none';
}

export interface DraftField {
  text: string;
  error: string | null;
}

export interface PricingDraft {
  fields: Record<string, DraftField>;
  /** Valid draft in normal form; null when a field has an error. */
  adjustments: GroupAdjustment[] | null;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/** The editor's GET query -> the draft; null without `draft=1`. */
export function parsePricingDraft(
  params: Record<string, string | string[] | undefined>,
): PricingDraft | null {
  if (first(params.draft) !== '1') return null;
  const fields: Record<string, DraftField> = {};
  const list: GroupAdjustment[] = [];
  let valid = true;
  for (const group of PRICE_GROUPS) {
    const deltas = { local: 0, order: 0 };
    for (const side of ['local', 'order'] as const) {
      const name = draftField(side, group);
      const text = first(params[name]).trim().slice(0, 16);
      const bp = parsePercentPoints(text);
      let error: string | null = null;
      if (bp === null) error = 'Число п.п., например +3 или −1,5';
      else if (Math.abs(bp) > MAX_GROUP_DELTA_BP) error = 'Не больше ±50 п.п.';
      else deltas[side] = bp;
      if (error !== null) valid = false;
      fields[name] = { text, error };
    }
    list.push({ group, localDeltaBp: deltas.local, orderDeltaBp: deltas.order });
  }
  return { fields, adjustments: valid ? normalizeGroupAdjustments(list) : null };
}

export function sameAdjustments(
  a: readonly GroupAdjustment[],
  b: readonly GroupAdjustment[],
): boolean {
  return (
    JSON.stringify(normalizeGroupAdjustments(a)) === JSON.stringify(normalizeGroupAdjustments(b))
  );
}

export interface PricingExample {
  id: string;
  title: string;
  group: PriceGroup;
  isLocal: boolean;
  supplierKop: number;
  competitorTotalKop: number;
  current: OfferPrice;
  draft: OfferPrice;
}

/**
 * Up to PREVIEW_EXAMPLES recent comparisons with our snapshot, priced now and with the draft:
 * positions whose adjustment the draft changes first, then the newest.
 */
export function pricingExamples(
  rows: readonly AdminPriceRow[],
  current: PricingConfig,
  draft: PricingConfig,
  limit = PREVIEW_EXAMPLES,
): PricingExample[] {
  const delta = (config: PricingConfig, group: PriceGroup, isLocal: boolean) => {
    const adjustment = groupAdjustmentOf(config.groupAdjustments, group);
    return isLocal ? adjustment.localDeltaBp : adjustment.orderDeltaBp;
  };
  const candidates = rows.filter(
    (row) => row.ourSupplierKop !== null && row.ourSupplierKop > 0 && row.ourIsLocal !== null,
  );
  const changed = (row: AdminPriceRow) =>
    delta(current, row.priceGroup, row.ourIsLocal === true) !==
    delta(draft, row.priceGroup, row.ourIsLocal === true);
  const ordered = [...candidates.filter(changed), ...candidates.filter((row) => !changed(row))];
  const seen = new Set<string>();
  const out: PricingExample[] = [];
  for (const row of ordered) {
    const key = `${row.brand}:${row.article}:${String(row.ourIsLocal)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const input = {
      priceSupplierKop: row.ourSupplierKop as number,
      isLocal: row.ourIsLocal === true,
      group: row.priceGroup,
    };
    out.push({
      id: row.id,
      title: `${row.brand} ${row.article}`,
      group: row.priceGroup,
      isLocal: input.isLocal,
      supplierKop: input.priceSupplierKop,
      competitorTotalKop: competitorTotalKop(row),
      current: priceFor(current, input),
      draft: priceFor(draft, input),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface PricingAuditRow {
  id: string;
  changedAt: Date;
  changedBy: string;
  oldValue: GroupAdjustment[] | null;
  newValue: GroupAdjustment[] | null;
}

export interface AdminPricingData {
  config: PricingConfig;
  bounds: PricingBounds;
  /** settings pricing.margin_floor_pct (percent, as stored). */
  marginFloorPct: number;
  version: string;
  updatedAt: Date | null;
  updatedBy: string | null;
  report: BenchmarkGroupStats[];
  reportDays: number;
  draft: PricingDraft | null;
  /** The draft as a config (null without a valid draft). */
  draftConfig: PricingConfig | null;
  examples: PricingExample[];
  audit: PricingAuditRow[];
}

const DAY_MS = 86_400_000;

function isPct(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

export async function loadAdminPricing(
  db: Executor,
  env: Env,
  params: Record<string, string | string[] | undefined>,
  now: Date,
): Promise<AdminPricingData> {
  const rows = await db
    .select({
      key: settings.key,
      value: settings.value,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy,
    })
    .from(settings)
    .where(inArray(settings.key, [...PRICING_KEYS]));
  const values = new Map(rows.map((row) => [row.key, row.value as unknown]));
  const defaults = settingsDefaultsFromEnv(env);
  const marginRaw = values.get('pricing.margin_floor_pct');
  const marginFloorPct = isPct(marginRaw) ? marginRaw : defaults['pricing.margin_floor_pct'];
  const marginFloorBp = pctToBp(marginFloorPct);
  // The same resolver as the settings readers of web and the worker.
  const config = resolvePricingConfig(values, defaults, marginFloorBp);
  const bounds = resolvePricingBounds(
    values.get('pricing.min_markup_bp'),
    values.get('pricing.max_markup_bp'),
    { minBp: defaults['pricing.min_markup_bp'], maxBp: defaults['pricing.max_markup_bp'] },
    marginFloorBp,
  );
  const adjustmentsRow = rows.find((row) => row.key === ADJUSTMENTS_KEY) ?? null;

  const benchmarks = await loadBenchmarks(db, {
    since: new Date(now.getTime() - BENCHMARK_DEFAULT_DAYS * DAY_MS),
  });
  const draft = parsePricingDraft(params);
  const draftConfig =
    draft?.adjustments != null ? { ...config, groupAdjustments: draft.adjustments } : null;
  const examples = draftConfig ? pricingExamples(benchmarks, config, draftConfig) : [];

  const auditRows = await db
    .select()
    .from(settingsAudit)
    .where(eq(settingsAudit.key, ADJUSTMENTS_KEY))
    .orderBy(desc(settingsAudit.changedAt), desc(settingsAudit.id))
    .limit(AUDIT_ROWS);

  return {
    config,
    bounds,
    marginFloorPct,
    version: adjustmentsVersion(adjustmentsRow),
    updatedAt: adjustmentsRow?.updatedAt ?? null,
    updatedBy: adjustmentsRow?.updatedBy ?? null,
    report: benchmarkReport(benchmarks, config),
    reportDays: BENCHMARK_DEFAULT_DAYS,
    draft,
    draftConfig,
    examples,
    audit: auditRows.map((row) => ({
      id: row.id,
      changedAt: row.changedAt,
      changedBy: row.changedBy,
      oldValue: parseGroupAdjustments(row.oldValue),
      newValue: parseGroupAdjustments(row.newValue),
    })),
  };
}
