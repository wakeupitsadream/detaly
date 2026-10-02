import { Chip, ChipRow } from '@/components/ui/Chip';

/** Builds a /search URL; rendered as a plain <a> so no prefetch spends the search limit. */
export function searchHref(q: string, brand: string | null, localOnly: boolean): string {
  const params = new URLSearchParams({ q });
  if (brand) params.set('brand', brand);
  if (localOnly) params.set('local', '1');
  return `/search?${params.toString()}`;
}

function GroupLabel({ children }: { children: string }) {
  return (
    <span className="hidden w-20 shrink-0 pt-2.5 text-label text-muted md:block">{children}</span>
  );
}

/**
 * Filters of the results: where the part is (all / only in Orenburg) and, with more than one
 * brand, the brand. Chips are links; the active one has aria-current.
 */
export function FilterChips({
  query,
  brand,
  localOnly,
  brands,
}: {
  query: string;
  brand: string | null;
  localOnly: boolean;
  brands: readonly string[];
}) {
  const brandActive = (name: string) => brand?.toLowerCase() === name.toLowerCase();
  return (
    <div className="min-w-0 space-y-2" aria-label="Фильтры" role="group">
      <div className="flex min-w-0 gap-3">
        <GroupLabel>Наличие</GroupLabel>
        <ChipRow className="min-w-0 flex-1">
          <Chip href={searchHref(query, brand, false)} active={!localOnly}>
            Все предложения
          </Chip>
          <Chip href={searchHref(query, brand, true)} active={localOnly}>
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-ok" />
            Только в Оренбурге
          </Chip>
        </ChipRow>
      </div>
      {brands.length > 1 ? (
        <div className="flex min-w-0 gap-3">
          <GroupLabel>Бренд</GroupLabel>
          <ChipRow className="min-w-0 flex-1">
            <Chip href={searchHref(query, null, localOnly)} active={!brand}>
              Все бренды
            </Chip>
            {brands.map((name) => (
              <Chip
                key={name}
                href={searchHref(query, name, localOnly)}
                active={brandActive(name)}
                className="font-mono text-[0.8125rem] tracking-wide uppercase"
              >
                {name}
              </Chip>
            ))}
          </ChipRow>
        </div>
      ) : null}
    </div>
  );
}
