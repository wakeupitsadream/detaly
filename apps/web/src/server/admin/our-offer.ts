/**
 * Our own best exact offer for a price comparison (/admin/prices, docs/pricing.md): the offers of
 * the typed brand and article from the supplier search (the shared Rossko client, through the
 * 15-minute cache), priced exactly as search, cart and checkout price them (priceOffer with the
 * current PricingConfig), marked goods left out. «Best» is the lowest client price; equal prices
 * prefer the Orenburg stock, then the earlier date.
 */
import {
  CLIENT_TIME_ZONE,
  DateError,
  diffDays,
  etaDate,
  isExcluded,
  localDate,
  MoneyError,
  offerViewId,
  priceOffer,
  promisedDate,
  type IsoDate,
  type Kop,
  type Offer,
  type PriceGroup,
} from '@detaly/domain';
import { brandMatches } from '@detaly/vin';
import type { SearchSettings } from '../settings';

export interface OurOfferSnapshot {
  offerKey: string;
  brand: string;
  article: string;
  name: string;
  priceGroup: PriceGroup;
  ourSupplierKop: Kop;
  ourPriceKop: Kop;
  markupBp: number;
  ourIsLocal: boolean;
  /** Days from today (Asia/Yekaterinburg) to the date the client would be promised. */
  ourEtaDays: number;
  promisedDate: IsoDate;
}

export function bestExactOffer(
  offers: readonly Offer[],
  input: { brand: string; articleNorm: string },
  settings: Pick<SearchSettings, 'pricing' | 'excludedRules' | 'eta'>,
  now: Date,
): OurOfferSnapshot | null {
  const sameArticle = offers.filter((offer) => offer.articleNorm === input.articleNorm);
  const today = localDate(now, CLIENT_TIME_ZONE);
  const priced: OurOfferSnapshot[] = [];
  for (const offer of brandMatches(sameArticle, input.brand)) {
    if (isExcluded({ name: offer.name, group: offer.group }, settings.excludedRules).excluded) {
      continue;
    }
    let price;
    let eta: IsoDate;
    try {
      price = priceOffer(settings.pricing, offer);
      eta = etaDate(offer.stock, now, CLIENT_TIME_ZONE);
    } catch (error) {
      if (error instanceof MoneyError || error instanceof DateError) continue;
      throw error;
    }
    const promised = promisedDate([eta], settings.eta);
    priced.push({
      offerKey: offerViewId(offer),
      brand: offer.brand,
      article: offer.article,
      name: offer.name,
      priceGroup: price.priceGroup,
      ourSupplierKop: offer.priceSupplierKop,
      ourPriceKop: price.priceClientKop,
      markupBp: price.markupBp,
      ourIsLocal: offer.stock.isLocal,
      ourEtaDays: Math.max(0, diffDays(today, promised)),
      promisedDate: promised,
    });
  }
  priced.sort(
    (a, b) =>
      a.ourPriceKop - b.ourPriceKop ||
      Number(b.ourIsLocal) - Number(a.ourIsLocal) ||
      a.ourEtaDays - b.ourEtaDays ||
      (a.offerKey < b.offerKey ? -1 : a.offerKey > b.offerKey ? 1 : 0),
  );
  return priced[0] ?? null;
}
