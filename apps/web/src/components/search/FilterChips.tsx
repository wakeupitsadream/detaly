import type { OfferView } from '@detaly/domain';
import { Chip, ChipRow } from '@/components/ui/Chip';

/** Where the part is: everything, the Orenburg stock only, or to order only. */
export type StockFilter = 'all' | 'local' | 'order';

/** `local=1` and `order=1` of the /search URL; `local` wins when both are set. */
export function parseStockFilter(local: string, order: string): StockFilter {
  const on = (value: string) => value === '1' || value === 'true' || value === 'on';
  if (on(local)) return 'local';
  if (on(order)) return 'order';
  return 'all';
}

/** Offers the stock chip lets through. Display only: the search itself is not narrowed. */
export function filterByStock(offers: readonly OfferView[], stock: StockFilter): OfferView[] {
  if (stock === 'all') return [...offers];
  return offers.filter((offer) => (stock === 'local' ? offer.isLocal : !offer.isLocal));
}

/** Builds a /search URL; rendered as a plain <a> so no prefetch spends the search limit. */
export function searchHref(
  q: string,
  { brand = null, stock = 'all' }: { brand?: string | null; stock?: StockFilter } = {},
): string {
  const params = new URLSearchParams({ q });
  if (brand) params.set('brand', brand);
  if (stock === 'local') params.set('local', '1');
  if (stock === 'order') params.set('order', '1');
  return `/search?${params.toString()}`;
}

function Count({ value }: { value: number }) {
  return <span className="tabular-nums opacity-80">{value}</span>;
}

/**
 * Round filter chips over the results (docs/design-v2.md, «Поиск»): «Все», «В Оренбурге»,
 * «Под заказ» with their counts (an empty one is left out) and, with more than one brand, a
 * second row of brands. Chips are plain links; the active one carries aria-current.
 */
export function FilterChips({
  query,
  brand,
  stock,
  offers,
  brands,
}: {
  query: string;
  brand: string | null;
  stock: StockFilter;
  /** Offers before the stock chip: the counts on the chips. */
  offers: readonly OfferView[];
  brands: readonly string[];
}) {
  const local = offers.filter((offer) => offer.isLocal).length;
  const chips: { key: StockFilter; label: string; count: number }[] = [
    { key: 'all', label: 'Все', count: offers.length },
    { key: 'local', label: 'В Оренбурге', count: local },
    { key: 'order', label: 'Под заказ', count: offers.length - local },
  ];
  const brandActive = (name: string) => brand?.toLowerCase() === name.toLowerCase();
  return (
    <div className="min-w-0 space-y-2" aria-label="Фильтры" role="group">
      <ChipRow aria-label="Наличие">
        {/* A chip that would show nothing is left out, unless it is the active one. */}
        {chips
          .filter((chip) => chip.count > 0 || chip.key === 'all' || chip.key === stock)
          .map((chip) => (
            <Chip
              key={chip.key}
              href={searchHref(query, { brand, stock: chip.key })}
              active={stock === chip.key}
            >
              {chip.label}
              <Count value={chip.count} />
            </Chip>
          ))}
      </ChipRow>
      {brands.length > 1 ? (
        <ChipRow aria-label="Бренд">
          <Chip href={searchHref(query, { stock })} active={!brand}>
            Все бренды
          </Chip>
          {brands.map((name) => (
            <Chip
              key={name}
              href={searchHref(query, { brand: name, stock })}
              active={brandActive(name)}
            >
              {name}
            </Chip>
          ))}
        </ChipRow>
      ) : null}
    </div>
  );
}
