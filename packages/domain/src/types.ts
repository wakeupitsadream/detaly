/**
 * Contract file (step 0): shared data shapes passed between packages
 * (rossko -> domain -> web, config/db seeds -> domain, settings readers).
 *
 * Conventions:
 * - Money is an integer number of kopecks (`Kop`); never floats, never rubles in code.
 * - Markup is in basis points (`BasisPoints`): 2800 = 28%.
 * - Calendar dates are `IsoDate` strings 'YYYY-MM-DD' (no time, no zone); the zone used to
 *   derive them is stated where they are produced (Asia/Yekaterinburg for client promises).
 * - Optional values from external systems are `null`, not `undefined`, so they survive JSON
 *   round trips (offer_snapshot jsonb, Redis cache).
 */
import type { DocumentKind, ExcludedKind, Fulfillment, PaymentScheme, StaffRole } from './statuses';

/** Integer kopecks. */
export type Kop = number;
/** Integer basis points: 10000 = 100%. */
export type BasisPoints = number;
/** Calendar date 'YYYY-MM-DD'. */
export type IsoDate = string;

// ---------------------------------------------------------------------------
// Supplier offers (produced by @detaly/rossko mapSearchResult)
// ---------------------------------------------------------------------------

/** One supplier stock (warehouse) offering a part. Mirrors Rossko `stocks.stock[]`. */
export interface StockInfo {
  /** Rossko stock id; matched against `rossko.local_stock_ids` to set `isLocal`. */
  stockId: string;
  /** Stock located in Orenburg: eligible for pay_on_handover. */
  isLocal: boolean;
  /** Available quantity (Rossko `count`). */
  count: number;
  /** Minimal order step, >= 1 (Rossko `multiplicity`, default 1). */
  multiplicity: number;
  /** Rossko offer `type` as received (meaning to be confirmed against real responses). */
  type: string | null;
  /**
   * Delivery term in days (Rossko `delivery`), >= 0; null when Rossko gave no term (the date
   * then comes from `deliveryEnd` only).
   */
  deliveryDays: number | null;
  /** Raw Rossko `deliveryStart`; a value without offset is assumed Moscow time. */
  deliveryStart: string | null;
  /** Raw Rossko `deliveryEnd`; preferred over `deliveryDays` when present. */
  deliveryEnd: string | null;
  /** Rossko `extra` as received. */
  extra: string | null;
  /** Rossko stock `description` as received. */
  description: string | null;
}

/** A purchasable offer: one part at one stock. Also stored as `offer_snapshot` jsonb. */
export interface Offer {
  source: 'rossko';
  /** Brand as returned by the supplier. */
  brand: string;
  /** Article as returned by the supplier (display form). */
  article: string;
  /** Normalized article: upper case, only [A-Z0-9] (e.g. 'W 914/2' -> 'W9142'). */
  articleNorm: string;
  name: string;
  /** Supplier product group when available; used by `excluded_kind = 'group'` rules. */
  group: string | null;
  /** true for crosses (analogues), false for the requested article itself. */
  isCross: boolean;
  /** Supplier (wholesale) price per unit in kopecks. */
  priceSupplierKop: Kop;
  stock: StockInfo;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Markup by supplier price range: [fromKop, toKop) with toKop = null meaning infinity.
 * Rules must cover 0..infinity without gaps or overlaps (validateMarkupRules).
 */
export interface MarkupRule {
  fromKop: Kop;
  toKop: Kop | null;
  /** Markup for local (Orenburg) stocks. */
  localBp: BasisPoints;
  /** Markup for to-order stocks. */
  orderBp: BasisPoints;
}

export interface PriceResult {
  /** Client price per unit, rounded up to a whole ruble (multiple of 100). */
  priceClientKop: Kop;
  markupBp: BasisPoints;
}

export interface EtaSettings {
  /** Days added to the latest item ETA (settings `eta.buffer_days`). */
  bufferDays: number;
  /** Extra days when Rossko ships only after invoice payment (`eta.supplier_invoice_lag_days`). */
  invoiceLagDays: number;
  /** settings `rossko.prepay_invoice`. */
  prepayInvoice: boolean;
}

// ---------------------------------------------------------------------------
// Excluded (marked) goods
// ---------------------------------------------------------------------------

/**
 * keyword pattern grammar: lower case, 'ё' treated as 'е'; space-separated tokens, all must
 * match whole words of the name; a token ending with '*' is a word prefix ('антифриз*').
 * group pattern: compared with the offer product group (normalized the same way).
 */
export interface ExcludedRule {
  kind: ExcludedKind;
  pattern: string;
  reason: string | null;
}

export interface ExcludableItem {
  name: string;
  group?: string | null;
}

export interface ExclusionResult {
  excluded: boolean;
  /** Human readable reason (rule reason or pattern) when excluded. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// UI rows (buildOfferViews)
// ---------------------------------------------------------------------------

export interface OfferViewContext {
  markupRules: readonly MarkupRule[];
  excludedRules: readonly ExcludedRule[];
  eta: EtaSettings;
  now: Date;
  /** Zone for client-facing dates; default 'Asia/Yekaterinburg'. */
  timeZone?: string;
}

/**
 * A ready-to-render search row. Safe to send to the browser: contains no supplier price
 * or markup.
 */
export interface OfferView {
  /** Stable key: `${articleNorm}:${brand}:${stockId}`. */
  id: string;
  brand: string;
  article: string;
  articleNorm: string;
  name: string;
  isCross: boolean;
  /** Local stock: "В Оренбурге — оплата при получении"; otherwise "Под заказ — предоплата". */
  isLocal: boolean;
  stockId: string;
  available: number;
  multiplicity: number;
  priceClientKop: Kop;
  /** Formatted price, e.g. '1 280 ₽'. */
  priceText: string;
  /** Expected arrival date in `timeZone`. */
  etaDate: IsoDate;
  /** e.g. 'к чт 8 октября'. */
  promiseText: string;
  /** Excluded rows are shown with "не продаём онлайн, спросите в сервисе" and cannot be added. */
  excluded: boolean;
  excludedReason: string | null;
}

// ---------------------------------------------------------------------------
// Cart and checkout (phase 1A, docs/phase-1a-implementation.md section 3)
// ---------------------------------------------------------------------------

/** Which part of a cart is checked out: everything, the Orenburg lines or the to-order lines. */
export type CartPart = 'all' | 'local' | 'order';

/** A `cart_items` row in domain form. Prices are per unit. */
export interface CartLine {
  id: string;
  /** offerViewId(offer): `${articleNorm}:${brand}:${stockId}`. */
  offerKey: string;
  /** Normalized article of the search query that found the offer (repricing searches by it). */
  searchArticleNorm: string;
  qty: number;
  priceSupplierKop: Kop;
  priceClientKop: Kop;
  markupBp: BasisPoints;
  isLocal: boolean;
  etaDate: IsoDate | null;
  /** offer_snapshot: the supplier offer the prices were computed from. */
  offer: Offer;
}

/** What repricing changed in a line (shown by DiffBanner). `title` is lineTitle(offer). */
export type LineChange =
  | {
      kind: 'price';
      lineId: string;
      offerKey: string;
      title: string;
      oldPriceKop: Kop;
      newPriceKop: Kop;
      /** newPriceKop - oldPriceKop per unit (negative when cheaper). */
      deltaKop: number;
    }
  | { kind: 'qty'; lineId: string; offerKey: string; title: string; oldQty: number; newQty: number }
  | { kind: 'unavailable'; lineId: string; offerKey: string; title: string }
  | { kind: 'excluded'; lineId: string; offerKey: string; title: string; reason: string };

export interface RepricedLine extends CartLine {
  /** unavailable and excluded lines are removed from the cart by the caller. */
  status: 'ok' | 'unavailable' | 'excluded';
  /** Fresh supplier stock count (the old snapshot's when the search failed). */
  available: number;
  multiplicity: number;
  /** The search for this line's article failed: the line is kept unchanged, not re-checked. */
  stale: boolean;
}

export interface RepriceContext {
  markupRules: readonly MarkupRule[];
  excludedRules: readonly ExcludedRule[];
  eta: EtaSettings;
  now: Date;
  /** Zone for client-facing dates; default 'Asia/Yekaterinburg'. */
  timeZone?: string;
}

export interface CartTotals {
  /** Sum of client price x qty. */
  subtotalKop: Kop;
  /** Sum of supplier price x qty. */
  supplierKop: Kop;
  /** subtotal - supplier; negative when sold below cost. */
  marginKop: number;
  /** Sum of quantities. */
  itemsCount: number;
}

/** Why an order needs prepayment (several may apply). */
export type PrepayReason = 'to_order' | 'over_limit' | 'no_show' | 'courier';

export interface PaymentSchemeInput {
  allItemsLocal: boolean;
  totalKop: Kop;
  noShowCount: number;
  noShowLimit: number;
  onPickupMaxTotalKop: Kop;
  fulfillment: Fulfillment;
}

export interface PaymentSchemeDecision {
  scheme: PaymentScheme;
  /** Empty for pay_on_handover. */
  reasons: PrepayReason[];
}

// ---------------------------------------------------------------------------
// Settings (table `settings`: key -> jsonb value). Env provides defaults, admin edits win.
// ---------------------------------------------------------------------------

export interface SettingsValues {
  'pricing.markup_rules': MarkupRule[];
  'pricing.drift_tolerance_pct': number;
  'pricing.margin_floor_pct': number;
  'pricing.min_order_total_kop': Kop;
  'pricing.min_margin_kop': Kop;
  'eta.buffer_days': number;
  'eta.supplier_invoice_lag_days': number;
  'order.payment_ttl_min': number;
  'order.on_pickup_max_total_kop': Kop;
  'order.on_pickup_confirm_ttl_h': number;
  'pickup.window_prepaid_days': number;
  'pickup.window_cod_days': number;
  'supplier.return_days': number;
  'handed.complete_days': number;
  'handover.qr_ttl_min': number;
  'no_show.limit': number;
  'reminder.days': number[];
  'courier.fee_kop': Kop;
  'rossko.local_stock_ids': string[];
  'rossko.prepay_invoice': boolean;
}
export type SettingsKey = keyof SettingsValues;

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/** One entry of STAFF_SEED_JSON; staff rows are upserted by tgUserId. */
export interface StaffSeed {
  name: string;
  role: StaffRole;
  tgUserId: number | null;
  maxUserId: number | null;
  isActive: boolean;
}

/** Frontmatter of content/legal/<kind>/<version>.md. */
export interface LegalDocumentFrontmatter {
  title: string;
  kind: DocumentKind;
  version: string;
}
