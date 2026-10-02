/**
 * Pre-order recheck (decision Б12, docs/phase-1b-implementation.md section 8): the rossko worker
 * repeats GetSearch bypassing the cache for every unique `search_article_norm` of the order and
 * hands the fresh offers here. Pure: no I/O, `now` is passed in.
 *
 * - Per item: the fresh offer with the same offer_key, its stock against the ordered qty and the
 *   unit price drift (driftBp).
 * - Per order: priceDriftBp = ceil((Σ fresh·qty − Σ old·qty) · 10000 / Σ old·qty) over the items
 *   that still have an offer (0 when none has), allAvailable = every item has its offer, not
 *   excluded, with stock >= qty.
 * - Alternatives for problem items: other offers (crosses and other stocks) from the same fresh
 *   answer, not excluded, with enough stock, sold at the item's client price with a margin of at
 *   least marginFloorBp; up to three cheapest.
 *
 * VERIFY: matching by offer_key = `${articleNorm}:${brand}:${stockId}` and repeating the search
 * by the original query article rely on stable Rossko stock ids and on crosses being returned
 * for the query article again (docs/external.md R14, R15), the same assumption as cart.ts.
 */
import { CLIENT_TIME_ZONE, DateError, etaDate } from './dates';
import { isExcluded } from './excluded';
import { floorDiv, MoneyError, driftBp as unitDriftBp, marginBp, safeMul, sumKop } from './money';
import { validateQty } from './cart';
import { offerViewId } from './offers';
import type {
  RecheckAlternative,
  RecheckItemInput,
  RecheckItemResult,
  RecheckItemStatus,
  RecheckReason,
  RecheckResult,
} from './recheck-types';
import type { BasisPoints, EtaSettings, ExcludedRule, IsoDate, MarkupRule, Offer } from './types';

/** Alternatives offered per problem item. */
export const RECHECK_MAX_ALTERNATIVES = 3;

export class RecheckError extends RangeError {
  override name = 'RecheckError';
}

/** Fresh GetSearch offers keyed by the normalized query article (search_article_norm). */
export type FreshOffersBySearch =
  ReadonlyMap<string, readonly Offer[]> | Readonly<Record<string, readonly Offer[]>>;

export interface RecheckOrderInput {
  /** Live order items to be ordered from the supplier. */
  items: readonly RecheckItemInput[];
  /**
   * Fresh offers for every `searchArticleNorm` of `items`. A missing key throws RecheckError:
   * a failed search must be retried by the caller, never read as "the offer disappeared".
   * An empty list is a real "nothing found".
   */
  freshBySearch: FreshOffersBySearch;
  /**
   * Accepted for parity with the cart context (Б12). Alternatives are sold at the client price
   * of the item they replace, so the markup table does not set their price; their markupBp is
   * the effective markup at that price.
   */
  markupRules: readonly MarkupRule[];
  excludedRules: readonly ExcludedRule[];
  /** Accepted for parity with the cart context; promisedDate is computed by the engine. */
  eta: EtaSettings;
  now: Date;
  /** settings pricing.margin_floor_pct in bp: the minimal margin of an alternative. */
  marginFloorBp: BasisPoints;
  /**
   * settings pricing.drift_tolerance_pct in bp. When given, `reason` is decided against it and
   * items whose own drift exceeds it get alternatives. Without it only availability decides
   * `reason` (the transition guard recheckPassed applies the tolerance anyway).
   */
  driftToleranceBp?: BasisPoints;
  /** Zone for etaDate of alternatives; default 'Asia/Yekaterinburg'. */
  timeZone?: string;
}

function freshFor(fresh: FreshOffersBySearch, searchArticleNorm: string): readonly Offer[] {
  if (fresh instanceof Map) {
    const offers = fresh.get(searchArticleNorm);
    if (offers !== undefined) return offers;
  } else {
    const record = fresh as Readonly<Record<string, readonly Offer[]>>;
    if (Object.hasOwn(record, searchArticleNorm)) return record[searchArticleNorm] ?? [];
  }
  throw new RecheckError(`no fresh search result for ${searchArticleNorm}`);
}

function usablePrice(offer: Offer): boolean {
  return Number.isSafeInteger(offer.priceSupplierKop) && offer.priceSupplierKop > 0;
}

function validateItem(item: RecheckItemInput): void {
  if (!Number.isSafeInteger(item.qty) || item.qty <= 0) {
    throw new RecheckError(`invalid qty ${String(item.qty)} of item ${item.orderItemId}`);
  }
  for (const [label, value] of [
    ['supplier', item.priceSupplierKop],
    ['client', item.priceClientKop],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new MoneyError(`invalid ${label} price of item ${item.orderItemId}`);
    }
  }
}

/** Cheapest fresh offer with the given offer_key (the mapper dedupes, this is a safety net). */
function findOffer(offers: readonly Offer[], offerKey: string): Offer | null {
  let found: Offer | null = null;
  for (const offer of offers) {
    if (!usablePrice(offer) || offerViewId(offer) !== offerKey) continue;
    if (found === null || offer.priceSupplierKop < found.priceSupplierKop) found = offer;
  }
  return found;
}

function offerExcluded(offer: Offer, rules: readonly ExcludedRule[]): boolean {
  return isExcluded({ name: offer.name, group: offer.group }, rules).excluded;
}

/** Effective markup of selling at `clientKop`: floor((client − supplier) · 10000 / supplier). */
function effectiveMarkupBp(clientKop: number, supplierKop: number): BasisPoints {
  return Math.max(0, floorDiv(safeMul(clientKop - supplierKop, 10_000), supplierKop));
}

function alternativesFor(
  item: RecheckItemInput,
  offers: readonly Offer[],
  input: RecheckOrderInput,
): RecheckAlternative[] {
  const timeZone = input.timeZone ?? CLIENT_TIME_ZONE;
  const byKey = new Map<string, RecheckAlternative>();
  for (const offer of offers) {
    const offerKey = offerViewId(offer);
    if (offerKey === item.offerKey || !usablePrice(offer)) continue;
    if (offerExcluded(offer, input.excludedRules)) continue;
    const qtyCheck = validateQty(item.qty, {
      available: offer.stock.count,
      multiplicity: offer.stock.multiplicity,
    });
    if (!qtyCheck.ok) continue;
    if (offer.priceSupplierKop > item.priceClientKop) continue;
    const margin = marginBp(item.priceClientKop, offer.priceSupplierKop);
    if (margin < input.marginFloorBp) continue;
    let eta: IsoDate;
    try {
      eta = etaDate(offer.stock, input.now, timeZone);
    } catch (error) {
      if (error instanceof DateError) continue;
      throw error;
    }
    const alternative: RecheckAlternative = {
      offer,
      priceClientKop: item.priceClientKop,
      priceSupplierKop: offer.priceSupplierKop,
      markupBp: effectiveMarkupBp(item.priceClientKop, offer.priceSupplierKop),
      etaDate: eta,
      searchArticleNorm: item.searchArticleNorm,
      offerKey,
      marginBp: margin,
      available: offer.stock.count,
    };
    const existing = byKey.get(offerKey);
    if (existing === undefined || alternative.priceSupplierKop < existing.priceSupplierKop) {
      byKey.set(offerKey, alternative);
    }
  }
  return [...byKey.values()].sort(compareAlternatives).slice(0, RECHECK_MAX_ALTERNATIVES);
}

/** Cheapest first, then the earliest date, then the requested article before crosses. */
function compareAlternatives(a: RecheckAlternative, b: RecheckAlternative): number {
  return (
    a.priceSupplierKop - b.priceSupplierKop ||
    ((a.etaDate ?? '') < (b.etaDate ?? '') ? -1 : (a.etaDate ?? '') > (b.etaDate ?? '') ? 1 : 0) ||
    Number(a.offer.isCross) - Number(b.offer.isCross) ||
    (a.offerKey < b.offerKey ? -1 : a.offerKey > b.offerKey ? 1 : 0)
  );
}

/**
 * Compares the order with fresh supplier offers. Throws RecheckError for an empty order, an
 * item without a fresh search result or a bad qty, MoneyError for bad prices.
 */
export function recheckOrder(input: RecheckOrderInput): RecheckResult {
  const { items } = input;
  if (items.length === 0) throw new RecheckError('recheck needs at least one item');
  if (!Number.isSafeInteger(input.marginFloorBp)) {
    throw new RecheckError('marginFloorBp must be an integer');
  }
  const tolerance = input.driftToleranceBp;
  if (tolerance !== undefined && !Number.isSafeInteger(tolerance)) {
    throw new RecheckError('driftToleranceBp must be an integer');
  }
  for (const item of items) validateItem(item);

  // Two live items may point at the same offer: their stock is shared.
  const demand = new Map<string, number>();
  for (const item of items) {
    demand.set(item.offerKey, (demand.get(item.offerKey) ?? 0) + item.qty);
  }

  const results: RecheckItemResult[] = [];
  const oldAll: number[] = [];
  const oldMatched: number[] = [];
  const freshMatched: number[] = [];
  for (const item of items) {
    const offers = freshFor(input.freshBySearch, item.searchArticleNorm);
    const offer = findOffer(offers, item.offerKey);
    const oldLine = safeMul(item.priceSupplierKop, item.qty);
    oldAll.push(oldLine);

    let status: RecheckItemStatus;
    let drift: BasisPoints | null = null;
    if (offer === null) {
      status = 'unavailable';
    } else {
      oldMatched.push(oldLine);
      freshMatched.push(safeMul(offer.priceSupplierKop, item.qty));
      drift = unitDriftBp(item.priceSupplierKop, offer.priceSupplierKop);
      if (offerExcluded(offer, input.excludedRules)) status = 'excluded';
      else if (offer.stock.count < (demand.get(item.offerKey) ?? item.qty)) status = 'insufficient';
      else status = 'ok';
    }

    const problem = status !== 'ok' || (tolerance !== undefined && (drift ?? 0) > tolerance);
    results.push({
      orderItemId: item.orderItemId,
      offerKey: item.offerKey,
      status,
      qty: item.qty,
      oldPriceSupplierKop: item.priceSupplierKop,
      freshPriceSupplierKop: offer?.priceSupplierKop ?? null,
      driftBp: drift,
      available: offer?.stock.count ?? null,
      alternatives: problem ? alternativesFor(item, offers, input) : [],
    });
  }

  const oldSupplierTotalKop = sumKop(oldAll);
  const oldMatchedKop = sumKop(oldMatched);
  const freshSupplierTotalKop = sumKop(freshMatched);
  const priceDriftBp = oldMatchedKop === 0 ? 0 : unitDriftBp(oldMatchedKop, freshSupplierTotalKop);
  const allAvailable = results.every((r) => r.status === 'ok');

  let reason: RecheckReason | null = null;
  if (!allAvailable) reason = 'unavailable';
  else if (tolerance !== undefined && priceDriftBp > tolerance) reason = 'price_drift';

  return {
    items: results,
    priceDriftBp,
    allAvailable,
    oldSupplierTotalKop,
    freshSupplierTotalKop,
    reason,
  };
}
