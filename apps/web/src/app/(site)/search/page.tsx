import type { Metadata } from 'next';
import type { OfferView } from '@detaly/domain';
import { DemoDataBanner } from '@/components/DemoDataBanner';
import { EmptyState } from '@/components/EmptyState';
import { OfferRow } from '@/components/OfferRow';
import { SearchBar } from '@/components/SearchBar';
import { cartCountLabel } from '@/components/SiteHeader';
import { getBrand } from '@/server/brand';
import { requestCartCount } from '@/server/cart/count';
import { parseLocalFlag } from '@/server/api/search-handler';
import { isNamedError } from '@/server/errors';
import { getLogger } from '@/server/logger';
import { getSearchService } from '@/server/search';
import {
  SearchInputError,
  SearchUnavailableError,
  type SearchResponse,
} from '@/server/search-service';

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

// Search results are never indexed (also X-Robots-Tag from src/proxy.ts and robots.ts).
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const q = first((await searchParams).q)
    .trim()
    .slice(0, 64);
  return {
    title: q ? `Поиск «${q}»` : 'Поиск по артикулу',
    robots: { index: false, follow: false },
  };
}

/** Builds a /search URL; rendered as a plain <a> so no prefetch spends the search limit. */
function searchHref(q: string, brand: string | null, localOnly: boolean): string {
  const params = new URLSearchParams({ q });
  if (brand) params.set('brand', brand);
  if (localOnly) params.set('local', '1');
  return `/search?${params.toString()}`;
}

function pluralOffers(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'предложение';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'предложения';
  return 'предложений';
}

function Chip({ href, active, children }: { href: string; active: boolean; children: string }) {
  return (
    <a
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`inline-flex h-9 max-w-full items-center rounded-full border px-3 text-sm wrap-anywhere ${
        active ? 'border-ink bg-ink text-white' : 'border-line bg-card text-ink hover:border-faint'
      }`}
    >
      {children}
    </a>
  );
}

function OfferList({
  title,
  offers,
  searchArticleNorm,
}: {
  title: string;
  offers: OfferView[];
  searchArticleNorm: string;
}) {
  if (offers.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <ul className="space-y-3">
        {offers.map((offer) => (
          <OfferRow key={offer.id} offer={offer} searchArticleNorm={searchArticleNorm} />
        ))}
      </ul>
    </section>
  );
}

function Results({ result }: { result: SearchResponse }) {
  const { query, brand, localOnly, offers } = result;
  const exact = offers.filter((offer) => !offer.isCross);
  const crosses = offers.filter((offer) => offer.isCross);
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-muted" data-testid="results-summary">
          {result.totalBeforeFilters > 0
            ? `По запросу «${query}»: ${offers.length} ${pluralOffers(offers.length)}`
            : null}
        </p>
        {result.totalBeforeFilters > 0 ? (
          <div className="flex flex-wrap gap-2" aria-label="Фильтры">
            <Chip href={searchHref(query, brand, false)} active={!localOnly}>
              Все предложения
            </Chip>
            <Chip href={searchHref(query, brand, true)} active={localOnly}>
              Только в Оренбурге
            </Chip>
            {result.brands.length > 1
              ? [
                  <Chip key="all-brands" href={searchHref(query, null, localOnly)} active={!brand}>
                    Все бренды
                  </Chip>,
                  ...result.brands.map((name) => (
                    <Chip
                      key={name}
                      href={searchHref(query, name, localOnly)}
                      active={brand?.toLowerCase() === name.toLowerCase()}
                    >
                      {name}
                    </Chip>
                  )),
                ]
              : null}
          </div>
        ) : null}
      </div>

      {result.totalBeforeFilters === 0 ? (
        <EmptyState query={query} />
      ) : offers.length === 0 ? (
        <div className="rounded-card border border-dashed border-line bg-card p-6 text-center">
          <p className="text-muted">
            {localOnly
              ? 'В Оренбурге сейчас нет подходящих предложений, есть под заказ.'
              : 'Под выбранный фильтр предложений нет.'}
          </p>
          <a className="mt-3 inline-block underline" href={searchHref(query, null, false)}>
            Показать все предложения
          </a>
        </div>
      ) : (
        <>
          <OfferList
            title="Запрошенный артикул"
            offers={exact}
            searchArticleNorm={result.articleNorm}
          />
          <OfferList title="Аналоги" offers={crosses} searchArticleNorm={result.articleNorm} />
        </>
      )}
    </div>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const q = first(params.q).trim();
  const brandName = first(params.brand).trim();
  const localOnly = parseLocalFlag(first(params.local) || null);
  const brand = getBrand();
  const cartCount = await requestCartCount();

  let result: SearchResponse | null = null;
  let problem: string | null = null;
  if (q !== '') {
    try {
      result = await getSearchService().search({ q, brand: brandName || null, localOnly });
    } catch (error) {
      if (
        isNamedError(error, SearchInputError, 'SearchInputError') ||
        isNamedError(error, SearchUnavailableError, 'SearchUnavailableError')
      ) {
        problem = error.message;
      } else {
        getLogger().error({ err: error }, 'search page failed');
        problem = 'Поиск временно недоступен, попробуйте позже';
      }
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold md:text-3xl">Поиск по артикулу</h1>
      <SearchBar defaultValue={q} localOnly={localOnly} />
      {brand.demoData ? <DemoDataBanner /> : null}
      {problem ? (
        <p
          className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-warn"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      {result ? <Results result={result} /> : null}
      {cartCount > 0 ? (
        <p
          className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-card px-4 py-3 text-sm"
          data-testid="search-cart-link"
        >
          <span className="text-muted">В корзине {cartCountLabel(cartCount)}</span>
          <a
            href="/cart"
            className="inline-flex h-11 items-center rounded-xl border border-ink px-4 font-semibold hover:bg-ink hover:text-white"
          >
            Перейти в корзину
          </a>
        </p>
      ) : null}
    </div>
  );
}
