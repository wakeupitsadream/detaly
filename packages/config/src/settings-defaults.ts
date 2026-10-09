import type { MarkupRule, SettingsValues } from '@detaly/domain/types';
import type { Env } from './env';

const KOP_PER_RUB = 100;

/** Percent (at most two decimals) -> integer basis points: 28 -> 2800, 27.5 -> 2750. */
export function pctToBp(pct: number): number {
  return Math.round(pct * 100);
}

/**
 * Default markup ranges from docs/phase0-implementation.md section 3:
 * [0; 1000 ₽), [1000 ₽; 5000 ₽), [5000 ₽; ∞), all at PRICING_MARKUP_PCT for local and to-order.
 */
export function defaultMarkupRules(markupPct: number): MarkupRule[] {
  const bp = pctToBp(markupPct);
  return [
    { fromKop: 0, toKop: 100_000, localBp: bp, orderBp: bp },
    { fromKop: 100_000, toKop: 500_000, localBp: bp, orderBp: bp },
    { fromKop: 500_000, toKop: null, localBp: bp, orderBp: bp },
  ];
}

/**
 * Initial values for the `settings` table derived from env. Seeds insert them with
 * ON CONFLICT DO NOTHING so admin edits are never overwritten. Ruble env values are
 * converted to kopecks here and nowhere else.
 */
export function settingsDefaultsFromEnv(env: Env): SettingsValues {
  return {
    'pricing.markup_rules': defaultMarkupRules(env.PRICING_MARKUP_PCT),
    // Step 2 (docs/pricing.md): no group adjustments, so prices are the base table's; the floor
    // and the ceiling only bound adjustments (DEFAULT_MIN_MARKUP_BP / DEFAULT_MAX_MARKUP_BP of
    // @detaly/domain, checked by settings-defaults.test.ts).
    'pricing.group_adjustments': [],
    'pricing.min_markup_bp': 1_000,
    'pricing.max_markup_bp': 6_000,
    'pricing.drift_tolerance_pct': env.PRICE_DRIFT_TOLERANCE_PCT,
    'pricing.margin_floor_pct': env.MARGIN_FLOOR_PCT,
    'pricing.min_order_total_kop': env.MIN_ORDER_TOTAL * KOP_PER_RUB,
    'pricing.min_margin_kop': env.MIN_MARGIN_RUB * KOP_PER_RUB,
    'eta.buffer_days': env.ETA_BUFFER_DAYS,
    'eta.supplier_invoice_lag_days': env.SUPPLIER_INVOICE_LAG_DAYS,
    'order.payment_ttl_min': env.ORDER_PAYMENT_TTL_MIN,
    'order.on_pickup_max_total_kop': env.ON_PICKUP_MAX_TOTAL * KOP_PER_RUB,
    'order.on_pickup_confirm_ttl_h': env.ON_PICKUP_CONFIRM_TTL_H,
    'pickup.window_prepaid_days': env.PICKUP_WINDOW_PREPAID_DAYS,
    'pickup.window_cod_days': env.PICKUP_WINDOW_COD_DAYS,
    'supplier.return_days': env.SUPPLIER_RETURN_DAYS,
    'handed.complete_days': env.HANDED_COMPLETE_DAYS,
    'handover.qr_ttl_min': env.HANDOVER_QR_TTL_MIN,
    'no_show.limit': env.NO_SHOW_LIMIT,
    'reminder.days': [...env.REMINDER_DAYS],
    'courier.fee_kop': env.COURIER_FEE_RUB * KOP_PER_RUB,
    'rossko.local_stock_ids': [...env.ROSSKO_LOCAL_STOCK_IDS],
    'rossko.prepay_invoice': false,
    // PLAN section 3: the client has 24 hours to answer an alternative / new date.
    'approval.timeout_h': 24,
    // Step 3 (docs/reviews.md): the review reminder 3 days after `completed` (0 = off) and the
    // storefront rating line from 5 reviews and a snapshot of at most 45 days
    // (DEFAULT_REVIEW_* of @detaly/domain, checked by settings-defaults.test.ts).
    'reviews.reminder_days': 3,
    'reviews.min_count': 5,
    'reviews.max_age_days': 45,
    // Step 4 (docs/fit-check.md): the master answers a fit check within 60 minutes of working time
    // (DEFAULT_FIT_CHECK_SLA_MINUTES of @detaly/domain, checked by settings-defaults.test.ts).
    'fit_check.sla_minutes': 60,
  };
}
