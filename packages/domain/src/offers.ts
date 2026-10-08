/**
 * Search rows for the UI. The result is safe to send to the browser: supplier price and
 * markup never leave this function.
 */
import { CLIENT_TIME_ZONE, DateError, etaDate, formatPromise, promisedDate } from './dates';
import { isExcluded } from './excluded';
import { formatRub } from './money';
import { priceOffer } from './pricing';
import type { Offer, OfferView, OfferViewContext } from './types';

export function offerViewId(offer: Pick<Offer, 'articleNorm' | 'brand' | 'stock'>): string {
  return `${offer.articleNorm}:${offer.brand}:${offer.stock.stockId}`;
}

/**
 * Builds rows sorted for display: the requested article before crosses, sellable before
 * excluded, then by price and arrival date. Offers with an unusable supplier price
 * (not a positive integer) or delivery term (no parseable deliveryEnd and a negative or
 * fractional deliveryDays) are dropped, so one malformed supplier row cannot break the whole
 * search; duplicates (same id) keep the cheapest one.
 */
export function buildOfferViews(offers: readonly Offer[], ctx: OfferViewContext): OfferView[] {
  const timeZone = ctx.timeZone ?? CLIENT_TIME_ZONE;
  const byId = new Map<string, OfferView>();
  for (const offer of offers) {
    if (!Number.isSafeInteger(offer.priceSupplierKop) || offer.priceSupplierKop <= 0) continue;
    let eta: string;
    try {
      eta = etaDate(offer.stock, ctx.now, timeZone);
    } catch (error) {
      if (error instanceof DateError) continue;
      throw error;
    }
    const { priceClientKop } = priceOffer(ctx.pricing, offer);
    const exclusion = isExcluded({ name: offer.name, group: offer.group }, ctx.excludedRules);
    const view: OfferView = {
      id: offerViewId(offer),
      brand: offer.brand,
      article: offer.article,
      articleNorm: offer.articleNorm,
      name: offer.name,
      isCross: offer.isCross,
      isLocal: offer.stock.isLocal,
      stockId: offer.stock.stockId,
      available: offer.stock.count,
      multiplicity: Math.max(1, offer.stock.multiplicity),
      priceClientKop,
      priceText: formatRub(priceClientKop),
      etaDate: eta,
      promiseText: formatPromise(promisedDate([eta], ctx.eta)),
      excluded: exclusion.excluded,
      excludedReason: exclusion.reason,
    };
    const existing = byId.get(view.id);
    if (existing === undefined || view.priceClientKop < existing.priceClientKop) {
      byId.set(view.id, view);
    }
  }
  return [...byId.values()].sort(compareViews);
}

function compareViews(a: OfferView, b: OfferView): number {
  return (
    Number(a.isCross) - Number(b.isCross) ||
    Number(a.excluded) - Number(b.excluded) ||
    a.priceClientKop - b.priceClientKop ||
    (a.etaDate < b.etaDate ? -1 : a.etaDate > b.etaDate ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
