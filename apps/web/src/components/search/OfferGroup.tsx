import type { OfferView } from '@detaly/domain';
import { OfferRow } from '@/components/OfferRow';
import type { InstallPlanView } from '@/server/install/types';

/**
 * A group of offers («Запрошенный артикул», «Аналоги»): h2 with the count in a mono plate, a
 * short note on the right and a hairline under it.
 */
export function OfferGroup({
  id,
  title,
  note,
  offers,
  searchArticleNorm,
  orderingOpen,
  plans,
}: {
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
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-4 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-3">
        <h2 id={id} className="font-display text-lg leading-tight font-semibold md:text-xl">
          {title}
        </h2>
        <span className="inline-flex h-6 min-w-6 items-center justify-center self-center rounded-sm bg-ink px-1.5 font-mono text-xs font-semibold text-paper tabular-nums">
          {offers.length}
        </span>
        {note ? <p className="w-full text-sm text-muted sm:ml-auto sm:w-auto">{note}</p> : null}
      </div>
      <ul className="space-y-3">
        {offers.map((offer) => (
          <OfferRow
            key={offer.id}
            offer={offer}
            searchArticleNorm={searchArticleNorm}
            orderingOpen={orderingOpen}
            install={plans ? (plans.get(offer.id) ?? null) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}
