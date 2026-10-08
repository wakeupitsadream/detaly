/**
 * Read-only view of `settings` and `excluded_groups` for search and checkout, cached in memory for a short
 * TTL (admin edits apply within a minute). Missing or malformed keys fall back to the env
 * defaults the seed would have written (settingsDefaultsFromEnv), and a database outage falls
 * back to those defaults plus DEFAULT_EXCLUDED_RULES, so search keeps working on cached
 * supplier data while Postgres is down.
 */
import { pctToBp, settingsDefaultsFromEnv, type Env } from '@detaly/config';
import type { Database } from '@detaly/db';
import {
  DEFAULT_EXCLUDED_RULES,
  parseWorkHours,
  resolvePricingConfig,
  type EtaSettings,
  type ExcludedRule,
  type Kop,
  type PaymentScheme,
  type PricingConfig,
  type SettingsValues,
} from '@detaly/domain';

export const SETTINGS_TTL_MS = 60_000;

const SEARCH_KEYS = [
  // pricing (docs/pricing.md): the base table, group adjustments, floor and ceiling; the margin
  // floor of «Заказать всё равно» lifts the markup floor (resolvePricingConfig)
  'pricing.markup_rules',
  'pricing.group_adjustments',
  'pricing.min_markup_bp',
  'pricing.max_markup_bp',
  'pricing.margin_floor_pct',
  'eta.buffer_days',
  'eta.supplier_invoice_lag_days',
  'rossko.prepay_invoice',
  'rossko.local_stock_ids',
  // order thresholds (phase 1A: cart hints, checkout, payment scheme)
  'pricing.min_order_total_kop',
  'pricing.min_margin_kop',
  'order.on_pickup_max_total_kop',
  'order.on_pickup_confirm_ttl_h',
  'no_show.limit',
  'order.payment_ttl_min',
  'courier.fee_kop',
  // how long a ready order waits at the point (checkout «Получение», the order page)
  'pickup.window_prepaid_days',
  'pickup.window_cod_days',
] as const satisfies readonly (keyof SettingsValues)[];

/** Order thresholds and terms (settings keys in comments; 0 kop thresholds = no minimum). */
export interface OrderSettings {
  /** pricing.min_order_total_kop */
  minOrderTotalKop: Kop;
  /** pricing.min_margin_kop */
  minMarginKop: Kop;
  /** order.on_pickup_max_total_kop */
  onPickupMaxTotalKop: Kop;
  /** order.on_pickup_confirm_ttl_h */
  onPickupConfirmTtlH: number;
  /** no_show.limit */
  noShowLimit: number;
  /** order.payment_ttl_min */
  paymentTtlMin: number;
  /** courier.fee_kop */
  courierFeeKop: Kop;
  /** pickup.window_prepaid_days: days a prepaid order waits at the point after «Приехало». */
  pickupWindowPrepaidDays: number;
  /** pickup.window_cod_days: the same for payment on handover. */
  pickupWindowCodDays: number;
}

/** Days a ready order waits at the point under this payment scheme (the engine's window). */
export function storageDays(
  order: Pick<OrderSettings, 'pickupWindowPrepaidDays' | 'pickupWindowCodDays'>,
  scheme: PaymentScheme,
): number {
  return scheme === 'prepay' ? order.pickupWindowPrepaidDays : order.pickupWindowCodDays;
}

export interface SearchSettings {
  /** What priceOffer needs; the worker resolves the same keys the same way (@detaly/orders). */
  pricing: PricingConfig;
  excludedRules: ExcludedRule[];
  eta: EtaSettings;
  localStockIds: string[];
  order: OrderSettings;
  /** false when the values come from env fallbacks because the database failed. */
  fromDatabase: boolean;
}

export interface SettingsReader {
  get(): Promise<SearchSettings>;
  /**
   * Drops the cached values: the next get() reads the database (the admin calls it after saving
   * prices, so the next search already uses them).
   */
  invalidate(): void;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return isNonNegativeInt(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Percent with at most two decimals, 0..100 (as in @detaly/orders). */
function isPct(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** Merges raw `settings` rows over env defaults, ignoring malformed values. */
export function resolveSearchSettings(
  rows: ReadonlyMap<string, unknown>,
  env: Env,
  excludedRules: ExcludedRule[],
): Omit<SearchSettings, 'fromDatabase'> {
  const defaults = settingsDefaultsFromEnv(env);
  const pick = <K extends keyof SettingsValues>(
    key: K,
    valid: (value: unknown) => boolean,
  ): SettingsValues[K] => {
    const value = rows.get(key);
    return (value !== undefined && valid(value) ? value : defaults[key]) as SettingsValues[K];
  };
  return {
    pricing: resolvePricingConfig(rows, defaults, pctToBp(pick('pricing.margin_floor_pct', isPct))),
    excludedRules,
    eta: {
      bufferDays: pick('eta.buffer_days', isNonNegativeInt),
      invoiceLagDays: pick('eta.supplier_invoice_lag_days', isNonNegativeInt),
      prepayInvoice: pick('rossko.prepay_invoice', (value) => typeof value === 'boolean'),
      pickupSchedule: parseWorkHours(env.PICKUP_HOURS ?? null),
    },
    localStockIds: pick('rossko.local_stock_ids', isStringArray),
    order: {
      minOrderTotalKop: pick('pricing.min_order_total_kop', isNonNegativeInt),
      minMarginKop: pick('pricing.min_margin_kop', isNonNegativeInt),
      onPickupMaxTotalKop: pick('order.on_pickup_max_total_kop', isNonNegativeInt),
      onPickupConfirmTtlH: pick('order.on_pickup_confirm_ttl_h', isPositiveInt),
      noShowLimit: pick('no_show.limit', isPositiveInt),
      paymentTtlMin: pick('order.payment_ttl_min', isPositiveInt),
      courierFeeKop: pick('courier.fee_kop', isNonNegativeInt),
      pickupWindowPrepaidDays: pick('pickup.window_prepaid_days', isPositiveInt),
      pickupWindowCodDays: pick('pickup.window_cod_days', isPositiveInt),
    },
  };
}

export interface SettingsReaderOptions {
  db: Database;
  env: Env;
  ttlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export function createSettingsReader({
  db,
  env,
  ttlMs = SETTINGS_TTL_MS,
  now = Date.now,
  onError,
}: SettingsReaderOptions): SettingsReader {
  let cached: { value: SearchSettings; at: number } | null = null;
  let inflight: Promise<SearchSettings> | null = null;
  /** Bumped by invalidate(): a load started before it must not cache its (older) values. */
  let generation = 0;

  async function load(started: number): Promise<SearchSettings> {
    try {
      // Relational queries take operators from the callback: web does not import drizzle-orm.
      const [rows, excluded] = await Promise.all([
        db.query.settings.findMany({
          columns: { key: true, value: true },
          where: (t, { inArray }) => inArray(t.key, [...SEARCH_KEYS]),
        }),
        db.query.excludedGroups.findMany({
          columns: { kind: true, pattern: true, reason: true },
          where: (t, { eq }) => eq(t.active, true),
        }),
      ]);
      const map = new Map(rows.map((row) => [row.key, row.value as unknown]));
      const value = { ...resolveSearchSettings(map, env, excluded), fromDatabase: true };
      if (started === generation) cached = { value, at: now() };
      return value;
    } catch (error) {
      onError?.(error);
      // Keep serving the last good values; without them use env defaults, but do not cache
      // the fallback so the next request retries the database.
      if (cached) return cached.value;
      return {
        ...resolveSearchSettings(new Map(), env, [...DEFAULT_EXCLUDED_RULES]),
        fromDatabase: false,
      };
    }
  }

  return {
    get() {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
      if (inflight === null) {
        const pending = load(generation).finally(() => {
          if (inflight === pending) inflight = null;
        });
        inflight = pending;
      }
      return inflight;
    },
    invalidate() {
      generation += 1;
      // Stale, not gone: a database failure on the next read still serves the last values.
      if (cached) cached = { value: cached.value, at: Number.NEGATIVE_INFINITY };
      inflight = null;
    },
  };
}

/**
 * The env implementation of SettingsReader (DEMO_MODE, no database): the values the seed would
 * have written (settingsDefaultsFromEnv) and the default stop list, computed once.
 */
export function createEnvSettingsReader(env: Env): SettingsReader {
  const value: SearchSettings = {
    ...resolveSearchSettings(new Map(), env, [...DEFAULT_EXCLUDED_RULES]),
    fromDatabase: false,
  };
  return { get: () => Promise.resolve(value), invalidate: () => undefined };
}
