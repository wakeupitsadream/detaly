import { normalizeVin } from '@detaly/vin/vin';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { DemoDataBanner } from '@/components/DemoDataBanner';
import { EmptyState } from '@/components/EmptyState';
import {
  IconArrowRight,
  IconBox,
  IconCart,
  IconDocument,
  IconPhone,
  IconReceipt,
  IconSts,
} from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { InnerPage, PageBody } from '@/components/page/PageBand';
import {
  FilterChips,
  filterByStock,
  parseStockFilter,
  searchHref,
  type StockFilter,
} from '@/components/search/FilterChips';
import { OfferGroup, offerMarks, sortOffersForChoice } from '@/components/search/OfferGroup';
import { ResultsHeader } from '@/components/search/ResultsHeader';
import { cartCountLabel } from '@/components/SiteHeader';
import { ButtonLink } from '@/components/ui/Button';
import { CtaCard } from '@/components/ui/CtaCard';
import { VinCtaArt } from '@/components/vin/VinCtaArt';
import { vinRequestFromQuery, vinRequestHref } from '@/lib/vin-link';
import { getBrand, telHref } from '@/server/brand';
import { requestCartCount } from '@/server/cart/count';
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

/** While online checkout is closed: how to order now, with a call button (no cart buttons). */
function OrderByPhoneHint({ phone }: { phone: string | null }) {
  return (
    <Notice tone="info" title="Заказ на сайте скоро откроется" data-testid="order-by-phone">
      {phone ? (
        <a
          className="mt-1 inline-flex min-h-11 items-center gap-2 font-bold whitespace-nowrap underline underline-offset-4"
          href={telHref(phone)}
        >
          <IconPhone size={20} />
          Заказать по телефону {phone}
        </a>
      ) : (
        <p>Пока заказать можно в пункте выдачи.</p>
      )}
    </Notice>
  );
}

/** The bare /search: no query yet. Where the article is written, and the VIN way instead. */
function SearchIdle({ demoData }: { demoData: boolean }) {
  const places = [
    { icon: <IconBox size={40} />, title: 'На старой детали' },
    { icon: <IconReceipt size={40} />, title: 'В заказ-наряде' },
    { icon: <IconDocument size={40} />, title: 'В каталоге' },
  ] as const;
  return (
    <div className="min-w-0 space-y-8 md:space-y-10">
      <div className="min-w-0">
        <h1 className="text-h1 text-balance">Поиск по артикулу</h1>
        <p className="mt-2 text-body text-muted">Введите артикул в строку поиска вверху.</p>
      </div>
      {demoData ? <DemoDataBanner /> : null}
      <section aria-labelledby="where-article" className="min-w-0">
        <h2 id="where-article" className="text-h3">
          Где найти артикул
        </h2>
        <ul className="mt-4 grid min-w-0 grid-cols-3 gap-3 md:max-w-3xl md:gap-4">
          {places.map((place) => (
            <li
              key={place.title}
              className="flex min-w-0 flex-col items-center gap-3 rounded-tile bg-surface px-2 py-5 text-center md:py-7"
            >
              <span aria-hidden className="text-brand">
                {place.icon}
              </span>
              <span className="text-[1rem] leading-snug font-semibold">{place.title}</span>
            </li>
          ))}
        </ul>
      </section>
      <CtaCard
        title="Не знаете артикул?"
        titleId="search-vin-cta"
        text="Мастер подберёт деталь по VIN бесплатно."
        art={<VinCtaArt />}
        action={{
          href: vinRequestHref(),
          label: 'Подобрать по VIN',
          icon: <IconSts size={22} />,
        }}
      />
    </div>
  );
}

function Results({
  result,
  stock,
  orderingOpen,
  plans,
  demoData,
  contactPhone,
}: {
  result: SearchResponse;
  stock: StockFilter;
  demoData: boolean;
  contactPhone: string | null;
  orderingOpen: boolean;
  plans: ReadonlyMap<string, InstallPlanView | null>;
}) {
  const { query, brand } = result;
  if (result.totalBeforeFilters === 0) return <EmptyState query={query} demoData={demoData} />;
  const offers = filterByStock(result.offers, stock);
  const exact = offers.filter((offer) => !offer.isCross);
  const crosses = offers.filter((offer) => offer.isCross);
  // «Быстрее всего» / «Дешевле всего» once per page: exact matches first win a tie.
  const marks = offerMarks([...sortOffersForChoice(exact), ...sortOffersForChoice(crosses)], plans);
  return (
    <div className="min-w-0 space-y-7 md:space-y-14">
      <div className="min-w-0 space-y-5">
        <ResultsHeader query={query} count={offers.length} />
        <FilterChips
          query={query}
          brand={brand}
          stock={stock}
          offers={result.offers}
          brands={result.brands}
        />
      </div>

      {offers.length === 0 ? (
        <Notice tone="neutral" title="С этим фильтром ничего нет">
          <a
            className="mt-1 inline-flex min-h-11 items-center gap-1.5 font-bold underline underline-offset-4"
            href={searchHref(query)}
          >
            Показать все предложения
            <IconArrowRight size={18} />
          </a>
        </Notice>
      ) : (
        <>
          <OfferGroup
            id="offers-exact"
            title="Точное совпадение"
            first
            marks={marks}
            offers={exact}
            searchArticleNorm={result.articleNorm}
            orderingOpen={orderingOpen}
            plans={plans}
            contactPhone={contactPhone}
          />
          <OfferGroup
            id="offers-cross"
            title="Аналоги"
            first={exact.length === 0}
            marks={marks}
            subtitle={`Другие бренды, подходят вместо ${query.toUpperCase()}`}
            offers={crosses}
            searchArticleNorm={result.articleNorm}
            orderingOpen={orderingOpen}
            plans={plans}
            contactPhone={contactPhone}
          />
        </>
      )}

      {/* The next step for the one who is not sure (no chip row under the header on phones
          outside the home page): the master checks by VIN, the article goes into the request. */}
      <CtaCard
        title="Не уверены, что подойдёт?"
        titleId="search-results-vin-cta"
        text="Мастер проверит по VIN бесплатно."
        art={<VinCtaArt />}
        testId="search-vin-cta"
        action={{
          href: vinRequestFromQuery(query).href,
          label: 'Подобрать по VIN',
          icon: <IconSts size={22} />,
          prefetch: false,
        }}
      />
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
  // A VIN typed into the search (the header form without JS, an old link) goes to the request
  // form: the search answers articles only.
  const vin = normalizeVin(q);
  if (vin) redirect(vinRequestHref({ vin }));

  const brandName = first(params.brand).trim();
  const stock = parseStockFilter(first(params.local), first(params.order));
  const brand = getBrand();
  const cartCount = await requestCartCount();

  let result: SearchResponse | null = null;
  let problem: string | null = null;
  // Gate checked only with a query: the bare page shows no offers.
  const orderingOpen = q !== '' ? (await currentCheckoutGate()).open : false;
  if (q !== '') {
    try {
      // The stock chips filter on the page, so every chip can show its count.
      result = await getSearchService().search({
        q,
        brand: brandName || null,
        localOnly: false,
      });
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
      <PageBody className="space-y-8 md:space-y-10">
        {problem ? (
          <>
            <h1 className="text-h1 wrap-anywhere">{q.toUpperCase()}</h1>
            <Notice tone="wait" role="alert">
              {problem}
            </Notice>
          </>
        ) : null}
        {result ? (
          <Results
            result={result}
            stock={stock}
            orderingOpen={orderingOpen}
            plans={plans}
            demoData={brand.demoData}
            contactPhone={brand.contactPhone}
          />
        ) : problem ? null : (
          <SearchIdle demoData={brand.demoData} />
        )}
        {result && result.offers.length > 0 && !orderingOpen ? (
          <OrderByPhoneHint phone={brand.contactPhone} />
        ) : null}
        {cartCount > 0 ? (
          <div
            className="hidden min-w-0 items-center justify-between gap-4 rounded-tile bg-surface px-6 py-4 md:flex"
            data-testid="search-cart-link"
          >
            <p className="flex min-w-0 items-center gap-3 text-body">
              <IconCart size={28} className="shrink-0 text-brand" />
              <span>
                В корзине <span className="font-bold">{cartCountLabel(cartCount)}</span>
              </span>
            </p>
            <ButtonLink href="/cart" prefetch={false} icon={<IconArrowRight size={20} />}>
              Перейти в корзину
            </ButtonLink>
          </div>
        ) : null}
      </PageBody>
    </InnerPage>
  );
}
