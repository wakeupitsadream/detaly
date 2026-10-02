import type { OfferView } from '@detaly/domain';
import { OfferRow, type OfferMark } from '@/components/OfferRow';
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

/** One line under the title when the same part sits both in Orenburg and at the supplier. */
function stocksNote(offers: readonly OfferView[]): string | null {
  const sellable = offers.filter((offer) => !offer.excluded);
  const local = sellable.filter((offer) => offer.isLocal);
  const order = sellable.filter((offer) => !offer.isLocal);
  if (local.length === 0 || order.length === 0) return null;
  const min = (list: OfferView[]) => Math.min(...list.map((offer) => offer.priceClientKop));
  return min(order) < min(local)
    ? 'Одна деталь — разные склады: под заказ дешевле, из Оренбурга быстрее'
    : 'Одна деталь — разные склады: из Оренбурга и быстрее, и не дороже';
}

/**
 * A group of offers («Запрошенный артикул», «Аналоги»): h3-sized title with the count in a mono
 * plate, a short note, a mono line on the stocks when the choice is price against time, and
 * the rows in the order a person chooses in.
 */
export function OfferGroup({
  id,
  title,
  note,
  offers,
  searchArticleNorm,
  orderingOpen,
  plans,
  explainStocks = false,
}: {
  /** The requested article: one part on different stocks, so say what the choice is. */
  explainStocks?: boolean;
  id: string;
  title: string;
  note?: string;
  offers: readonly OfferView[];
  searchArticleNorm: string;
  orderingOpen: boolean;
  /** Install plans by offer id; undefined: no lift line under the offers. */
  plans?: ReadonlyMap<string, InstallPlanView | null>;
}) {
  if (offers.length === 0) return null;
  const sorted = sortOffersForChoice(offers);
  const marks = offerMarks(sorted, plans);
  const stocks = explainStocks ? stocksNote(sorted) : null;
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-4 border-b border-line pb-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id={id} className="text-h3 md:text-xl">
            {title}
          </h2>
          <span className="inline-flex h-6 min-w-6 items-center justify-center self-center rounded-sm bg-ink px-1.5 font-mono text-xs font-semibold text-paper tabular-nums">
            {offers.length}
          </span>
          {note ? <p className="w-full text-sm text-muted sm:ml-auto sm:w-auto">{note}</p> : null}
        </div>
        {stocks ? <p className="mt-2 text-label text-accent-ink">{stocks}</p> : null}
      </div>
      <ul className="space-y-3">
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
