import type { OfferView } from '@detaly/domain';
import { plural } from '@/lib/plural';

export function pluralOffers(count: number): string {
  return plural(count, 'предложение', 'предложения', 'предложений');
}

/**
 * The line over the results: «По запросу «OC90»: 5 предложений» (data-testid results-summary,
 * the wording is kept) and, on the right, how many of them are in Orenburg and to order.
 */
export function ResultsHeader({ query, offers }: { query: string; offers: readonly OfferView[] }) {
  const local = offers.filter((offer) => offer.isLocal && !offer.excluded).length;
  const toOrder = offers.filter((offer) => !offer.isLocal && !offer.excluded).length;
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
      <p className="min-w-0 text-muted wrap-anywhere" data-testid="results-summary">
        По запросу «<span className="font-mono font-semibold text-ink">{query}</span>»:{' '}
        <span className="font-semibold text-ink">{offers.length}</span>{' '}
        {pluralOffers(offers.length)}
      </p>
      {offers.length > 0 ? (
        <p className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-label text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-1.5 rounded-full bg-ok" />
            {local} в Оренбурге
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-1.5 rounded-full bg-info" />
            {toOrder} под заказ
          </span>
        </p>
      ) : null}
    </div>
  );
}
