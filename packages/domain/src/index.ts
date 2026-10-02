// Public API of @detaly/domain. Pure functions only: no I/O, no env, no clock reads
// (time is always passed in). Step 0 stubs; implemented in work package P2.
import type { OrderStatus } from './statuses';
import type {
  EtaSettings,
  ExcludableItem,
  ExcludedRule,
  ExclusionResult,
  IsoDate,
  Kop,
  MarkupRule,
  Offer,
  OfferView,
  OfferViewContext,
  PriceResult,
  StockInfo,
} from './types';

export * from './statuses';
export type * from './types';

function notImplemented(name: string): never {
  throw new Error(`not implemented: @detaly/domain ${name}`);
}

/** Client price: ceil(p * (10000 + bp) / 1_000_000) * 100, integer math only. */
export function price(
  _rules: readonly MarkupRule[],
  _priceSupplierKop: Kop,
  _isLocal: boolean,
): PriceResult {
  return notImplemented('price');
}

/** Throws when ranges have gaps/overlaps or do not cover 0..infinity. */
export function validateMarkupRules(_rules: readonly MarkupRule[]): void {
  notImplemented('validateMarkupRules');
}

/** Calendar date of `instant` in `tz` (default Asia/Yekaterinburg). */
export function localDate(_instant: Date, _tz?: string): IsoDate {
  return notImplemented('localDate');
}

/** deliveryEnd when present, otherwise now + deliveryDays (client time zone). */
export function etaDate(_stock: StockInfo, _now: Date, _tz?: string): IsoDate {
  return notImplemented('etaDate');
}

/** max(etaDates) + bufferDays (+ invoiceLagDays when prepayInvoice). */
export function promisedDate(_etaDates: readonly IsoDate[], _settings: EtaSettings): IsoDate {
  return notImplemented('promisedDate');
}

/** '2026-10-08' -> 'к чт 8 октября' (no ICU). */
export function formatPromise(_date: IsoDate): string {
  return notImplemented('formatPromise');
}

export function isExcluded(
  _item: ExcludableItem,
  _rules: readonly ExcludedRule[],
): ExclusionResult {
  return notImplemented('isExcluded');
}

export function buildOfferViews(_offers: readonly Offer[], _ctx: OfferViewContext): OfferView[] {
  return notImplemented('buildOfferViews');
}

export interface TransitionRule {
  from: readonly OrderStatus[];
  event: string;
  to: OrderStatus;
  actors: readonly string[];
}

/** Declarative transition table (PLAN section 3). */
export const TRANSITIONS: readonly TransitionRule[] = [];

export type TransitionResult =
  { ok: true; rule: TransitionRule } | { ok: false; reason: 'no_rule' | 'guard_failed' };

export function resolveTransition(
  _status: OrderStatus,
  _event: string,
  _ctx: unknown,
): TransitionResult {
  return notImplemented('resolveTransition');
}
