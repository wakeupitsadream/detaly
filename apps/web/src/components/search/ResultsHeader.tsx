import { plural } from '@/lib/plural';

export function pluralOffers(count: number): string {
  return plural(count, 'предложение', 'предложения', 'предложений');
}

/**
 * Title of the results (docs/design-v2.md, «Поиск»): the article as the page's h1 and «Найдено
 * 5 предложений» under it. data-testid results-summary holds both, as the old summary line did.
 */
export function ResultsHeader({ query, count }: { query: string; count: number }) {
  return (
    <div className="min-w-0" data-testid="results-summary">
      <h1 className="text-h1 wrap-anywhere">
        <span className="sr-only">Поиск по артикулу </span>
        {query.toUpperCase()}
      </h1>
      <p className="mt-1 text-body text-muted">
        Найдено{' '}
        <span className="font-bold text-ink tabular-nums">
          {count} {pluralOffers(count)}
        </span>
      </p>
    </div>
  );
}
