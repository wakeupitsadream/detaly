/**
 * loadOrderSettings: `settings` rows over the env defaults the seed would have written
 * (settingsDefaultsFromEnv). A malformed value falls back to its default, as in web
 * (apps/web/src/server/settings.ts); the engine never caches: a transition reads the values of
 * its own transaction.
 */
import { pctToBp, settingsDefaultsFromEnv, type Env } from '@detaly/config';
import { inArray, settings, type Executor } from '@detaly/db';
import { validateMarkupRules, type MarkupRule, type SettingsValues } from '@detaly/domain';
import type { OrderSettings } from './types';

const KEYS = [
  'pricing.markup_rules',
  'pricing.drift_tolerance_pct',
  'pricing.margin_floor_pct',
  'pricing.min_order_total_kop',
  'pricing.min_margin_kop',
  'eta.buffer_days',
  'eta.supplier_invoice_lag_days',
  'order.payment_ttl_min',
  'order.on_pickup_max_total_kop',
  'order.on_pickup_confirm_ttl_h',
  'pickup.window_prepaid_days',
  'pickup.window_cod_days',
  'supplier.return_days',
  'handed.complete_days',
  'handover.qr_ttl_min',
  'no_show.limit',
  'reminder.days',
  'courier.fee_kop',
  'rossko.prepay_invoice',
  'approval.timeout_h',
] as const satisfies readonly (keyof SettingsValues)[];

const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPositiveInt = (v: unknown): v is number => isNonNegativeInt(v) && v > 0;
/** Percent with at most two decimals, 0..100. */
const isPct = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const isPositiveIntList = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => isPositiveInt(x));

function validRules(value: unknown): MarkupRule[] | null {
  if (!Array.isArray(value)) return null;
  try {
    validateMarkupRules(value as MarkupRule[]);
    return value as MarkupRule[];
  } catch {
    return null;
  }
}

/** Pure merge of raw rows (key -> jsonb value) over env defaults. */
export function resolveOrderSettings(rows: ReadonlyMap<string, unknown>, env: Env): OrderSettings {
  const defaults = settingsDefaultsFromEnv(env);
  const pick = <K extends keyof SettingsValues>(
    key: K,
    valid: (value: unknown) => boolean,
  ): SettingsValues[K] => {
    const value = rows.get(key);
    return (value !== undefined && valid(value) ? value : defaults[key]) as SettingsValues[K];
  };
  return {
    markupRules: validRules(rows.get('pricing.markup_rules')) ?? defaults['pricing.markup_rules'],
    eta: {
      bufferDays: pick('eta.buffer_days', isNonNegativeInt),
      invoiceLagDays: pick('eta.supplier_invoice_lag_days', isNonNegativeInt),
      prepayInvoice: pick('rossko.prepay_invoice', (v) => typeof v === 'boolean'),
    },
    driftToleranceBp: pctToBp(pick('pricing.drift_tolerance_pct', isPct)),
    marginFloorBp: pctToBp(pick('pricing.margin_floor_pct', isPct)),
    minOrderTotalKop: pick('pricing.min_order_total_kop', isNonNegativeInt),
    minMarginKop: pick('pricing.min_margin_kop', isNonNegativeInt),
    onPickupMaxTotalKop: pick('order.on_pickup_max_total_kop', isNonNegativeInt),
    onPickupConfirmTtlH: pick('order.on_pickup_confirm_ttl_h', isPositiveInt),
    paymentTtlMin: pick('order.payment_ttl_min', isPositiveInt),
    pickupWindowPrepaidDays: pick('pickup.window_prepaid_days', isPositiveInt),
    pickupWindowCodDays: pick('pickup.window_cod_days', isPositiveInt),
    supplierReturnDays: pick('supplier.return_days', isPositiveInt),
    handedCompleteDays: pick('handed.complete_days', isPositiveInt),
    handoverQrTtlMin: pick('handover.qr_ttl_min', isPositiveInt),
    noShowLimit: pick('no_show.limit', isPositiveInt),
    reminderDays: [...pick('reminder.days', isPositiveIntList)],
    courierFeeKop: pick('courier.fee_kop', isNonNegativeInt),
    approvalTimeoutH: pick('approval.timeout_h', isPositiveInt),
  };
}

/** `settings` + env defaults; malformed values are ignored, as in web. */
export async function loadOrderSettings(db: Executor, env: Env): Promise<OrderSettings> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...KEYS]));
  return resolveOrderSettings(new Map(rows.map((row) => [row.key, row.value as unknown])), env);
}
