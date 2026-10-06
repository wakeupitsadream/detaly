import type { OfferView } from '@detaly/domain';
import { OfferRow, type OfferMark } from '@/components/OfferRow';
import { SectionHeading } from '@/components/ui/Section';
import type { InstallPlanView } from '@/server/install/types';

/**
 * Order inside a group, for a person choosing: sellable before marked goods, Orenburg stock
 * first (paid on handover, here sooner), then the earlier date, then the lower price. Display
 * only: the search API keeps its own order.
 */
export function sortOffersForChoice(offers: readonly OfferView[]): OfferView[] {
  return [...offers].sort(
    (a, b) =>
      Number(a.excluded) - Number(b.excluded) ||
      Number(b.isLocal) - Number(a.isLocal) ||
      (a.etaDate < b.etaDate ? -1 : a.etaDate > b.etaDate ? 1 : 0) ||
      a.priceClientKop - b.priceClientKop,
  );
}

/** When the car is ready with this offer: the lift slot when planned, else the part's date. */
function readyKey(offer: OfferView, plans?: ReadonlyMap<string, InstallPlanView | null>): string {
  return plans?.get(offer.id)?.slotStartIso ?? `${offer.etaDate}T99`;
}

/**
 * «Быстрее всего» and «Дешевле всего» for the rows that earn them, among two or more sellable
 * offers (one offer is both and says nothing).
 */
export function offerMarks(
  offers: readonly OfferView[],
  plans?: ReadonlyMap<string, InstallPlanView | null>,
): Map<string, OfferMark[]> {
  const marks = new Map<string, OfferMark[]>();
  const sellable = offers.filter((offer) => !offer.excluded);
  if (sellable.length < 2) return marks;
  const add = (id: string, mark: OfferMark) => marks.set(id, [...(marks.get(id) ?? []), mark]);
  const fastest = sellable.reduce((best, offer) =>
    readyKey(offer, plans) < readyKey(best, plans) ? offer : best,
  );
  const cheapest = sellable.reduce((best, offer) =>
    offer.priceClientKop < best.priceClientKop ? offer : best,
  );
  add(fastest.id, 'fastest');
  add(cheapest.id, 'cheapest');
  return marks;
}

/**
 * A group of offers («Точное совпадение», «Аналоги»; docs/design-v2.md, «Поиск»): the section
 * marker with the title and the count, then the offer cards in the order a person chooses in.
 */
export function OfferGroup({
  id,
  title,
  offers,
  searchArticleNorm,
  orderingOpen,
  plans,
  first = false,
}: {
  id: string;
  /** The first group under the filters: no marker on phones. */
  first?: boolean;
  title: string;
  offers: readonly OfferView[];
  searchArticleNorm: string;
  orderingOpen: boolean;
  /** Install plans by offer id; undefined: no lift line under the offers. */
  plans?: ReadonlyMap<string, InstallPlanView | null>;
}) {
  if (offers.length === 0) return null;
  const sorted = sortOffersForChoice(offers);
  const marks = offerMarks(sorted, plans);
  return (
    <section aria-labelledby={id} className="min-w-0">
      <SectionHeading id={id} phoneMarker={!first}>
        {title} <span className="font-bold text-muted tabular-nums">{offers.length}</span>
      </SectionHeading>
      <ul className="mt-5 space-y-3 md:mt-6 md:space-y-4">
        {sorted.map((offer) => (
          <OfferRow
            key={offer.id}
            offer={offer}
            searchArticleNorm={searchArticleNorm}
            orderingOpen={orderingOpen}
            install={plans ? (plans.get(offer.id) ?? null) : undefined}
            marks={marks.get(offer.id)}
          />
        ))}
      </ul>
    </section>
  );
}
