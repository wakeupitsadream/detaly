import type { Metadata } from 'next';
import { DemoDataBanner } from '@/components/DemoDataBanner';
import { EmptyState } from '@/components/EmptyState';
import { IconArrowRight, IconCart, IconPhone } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { SearchBar } from '@/components/SearchBar';
import { FilterChips, searchHref } from '@/components/search/FilterChips';
import { OfferGroup } from '@/components/search/OfferGroup';
import { ResultsHeader } from '@/components/search/ResultsHeader';
import { cartCountLabel } from '@/components/SiteHeader';
import { buttonClass } from '@/components/ui/Button';
import { getBrand, telHref } from '@/server/brand';
import { requestCartCount } from '@/server/cart/count';
import { parseLocalFlag } from '@/server/api/search-handler';
import { currentCheckoutGate } from '@/server/checkout-gate';
import { isNamedError } from '@/server/errors';
import { planInstallForOffers, type InstallPlanView } from '@/server/install';
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

/** While online checkout is closed: how to order now, with a phone link (no cart buttons). */
function OrderByPhoneHint({ phone }: { phone: string | null }) {
  return (
    <Notice tone="info" data-testid="order-by-phone">
      Оформление заказа на сайте скоро откроется.
      {phone ? (
        <>
          {' '}
          Сейчас заказать можно по телефону{' '}
          <a
            className="inline-flex items-center gap-1 font-semibold whitespace-nowrap underline underline-offset-4"
            href={telHref(phone)}
          >
            <IconPhone size={14} />
            {phone}
          </a>
          .
        </>
      ) : (
        ' Сейчас заказать можно в пункте выдачи.'
      )}
    </Notice>
  );
}

/** The bare /search: no query yet, so where to find an article instead of an empty page. */
function SearchIdle() {
  const places = [
    ['01', 'На старой детали', 'Выбит или напечатан на корпусе, рядом с логотипом бренда.'],
    ['02', 'В заказ-наряде', 'Сервис записывает артикул каждой детали, которую ставил.'],
    ['03', 'В каталоге производителя', 'По марке, модели и году выпуска машины.'],
  ] as const;
  return (
    <section aria-labelledby="where-article" className="min-w-0">
      <h2 id="where-article" className="font-display text-lg font-semibold md:text-xl">
        Где найти артикул
      </h2>
      <ol className="mt-5 grid min-w-0 gap-px overflow-hidden rounded border border-line bg-line md:grid-cols-3">
        {places.map(([index, title, text]) => (
          <li key={index} className="min-w-0 bg-card p-5">
            <span className="font-mono text-xs font-semibold text-accent-ink">{index}</span>
            <p className="mt-2 font-semibold">{title}</p>
            <p className="mt-1 text-sm text-muted">{text}</p>
          </li>
        ))}
      </ol>
      <p className="mt-5 text-muted">
        Артикула нет совсем?{' '}
        <a href="/vin" className="font-semibold text-accent-ink underline underline-offset-4">
          Мастер подберёт деталь по VIN
        </a>{' '}
        — бесплатно.
      </p>
    </section>
  );
}

function Results({
  result,
  orderingOpen,
  plans,
}: {
  result: SearchResponse;
  orderingOpen: boolean;
  plans: ReadonlyMap<string, InstallPlanView | null>;
}) {
  const { query, brand, localOnly, offers } = result;
  if (result.totalBeforeFilters === 0) return <EmptyState query={query} />;
  const exact = offers.filter((offer) => !offer.isCross);
  const crosses = offers.filter((offer) => offer.isCross);
  return (
    <div className="min-w-0 space-y-10 md:space-y-12">
      <div className="min-w-0 space-y-4">
        <ResultsHeader query={query} offers={offers} />
        <FilterChips query={query} brand={brand} localOnly={localOnly} brands={result.brands} />
      </div>

      {offers.length === 0 ? (
        <Notice tone="neutral">
          <p>
            {localOnly
              ? 'В Оренбурге сейчас нет подходящих предложений, есть под заказ.'
              : 'Под выбранный фильтр предложений нет.'}
          </p>
          <a
            className="mt-2 inline-flex min-h-11 items-center gap-1.5 font-semibold underline underline-offset-4"
            href={searchHref(query, null, false)}
          >
            Показать все предложения
            <IconArrowRight size={16} />
          </a>
        </Notice>
      ) : (
        <>
          <OfferGroup
            id="offers-exact"
            title="Запрошенный артикул"
            note="Ровно та деталь, что вы искали, у разных поставщиков"
            offers={exact}
            searchArticleNorm={result.articleNorm}
            orderingOpen={orderingOpen}
            plans={plans}
          />
          <OfferGroup
            id="offers-cross"
            title="Аналоги"
            note="Взаимозаменяемые детали других брендов"
            offers={crosses}
            searchArticleNorm={result.articleNorm}
            orderingOpen={orderingOpen}
            plans={plans}
          />
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
  // Gate checked only with a query: the bare page shows no offers.
  const orderingOpen = q !== '' ? (await currentCheckoutGate()).open : false;
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

  // One lift-load snapshot for the whole page; a failure only drops the install lines.
  let plans: ReadonlyMap<string, InstallPlanView | null> = new Map();
  if (result && result.offers.length > 0) {
    try {
      plans = await planInstallForOffers(result.offers, new Date());
    } catch (error) {
      getLogger().warn({ err: error }, 'search page: install plan unavailable');
    }
  }

  return (
    <InnerPage>
      <PageBand
        eyebrow="Каталог · цена и дата сразу"
        title="Поиск по артикулу"
        lead={
          q === ''
            ? 'Введите артикул с детали или из каталога: покажем цену, дату получения в Оренбурге и ближайшее окно на подъёмнике.'
            : undefined
        }
      >
        <div className="max-w-3xl">
          <SearchBar defaultValue={q} localOnly={localOnly} onDark large hint={q === ''} />
        </div>
      </PageBand>

      <PageBody className="space-y-8 md:space-y-10">
        {brand.demoData ? <DemoDataBanner /> : null}
        {problem ? (
          <Notice tone="wait" role="alert">
            {problem}
          </Notice>
        ) : null}
        {result ? (
          <Results result={result} orderingOpen={orderingOpen} plans={plans} />
        ) : problem ? null : (
          <SearchIdle />
        )}
        {result && result.offers.length > 0 && !orderingOpen ? (
          <OrderByPhoneHint phone={brand.contactPhone} />
        ) : null}
        {cartCount > 0 ? (
          <div
            className="hidden min-w-0 items-center justify-between gap-4 rounded border border-ink bg-card px-5 py-4 md:flex"
            data-testid="search-cart-link"
          >
            <p className="flex min-w-0 items-center gap-3">
              <IconCart size={22} />
              <span>
                <span className="text-muted">В корзине </span>
                <span className="font-semibold">{cartCountLabel(cartCount)}</span>
              </span>
            </p>
            <a href="/cart" className={buttonClass({ variant: 'secondary' })}>
              Перейти в корзину
              <IconArrowRight size={18} />
            </a>
          </div>
        ) : null}
      </PageBody>
    </InnerPage>
  );
}
