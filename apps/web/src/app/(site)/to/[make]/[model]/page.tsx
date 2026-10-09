import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { IconSts } from '@/components/icons';
import { KitsDemoNote } from '@/components/kits/KitCatalog';
import { KitSection } from '@/components/kits/KitSection';
import { Notice } from '@/components/page/Notice';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { CtaCard } from '@/components/ui/CtaCard';
import { KIT_VIN_NEED, kitMakePath, kitModelPath, KITS_PATH } from '@/lib/kit-paths';
import { kitModelSeo } from '@/lib/seo';
import { vinRequestHref } from '@/lib/vin-link';
import { getBrand } from '@/server/brand';
import { CART_ERROR_MESSAGES, isCartErrorCode } from '@/server/cart/errors';
import { currentCheckoutGate } from '@/server/checkout-gate';
import { PageDataError } from '@/server/errors';
import { priceKitsNow } from '@/server/kits';
import { kitBrand, kitModels, publishedKits, type KitModelEntry } from '@/server/kits/catalog';

type Params = Promise<{ make: string; model: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

async function modelOf(make: string, model: string): Promise<KitModelEntry | null | undefined> {
  const list = await publishedKits();
  if (list === null) return undefined;
  return kitModels(list, make).find((entry) => entry.modelSlug === model) ?? null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { make, model } = await params;
  const brand = kitBrand(make);
  const entry = await modelOf(make, model);
  if (!brand || !entry) return {};
  const seo = kitModelSeo(
    brand.name,
    entry.model,
    entry.kits.map((kit) => kit.engine),
  );
  // No JSON-LD offers: the prices change with the supplier every day.
  return {
    title: seo.title,
    description: seo.description,
    alternates: { canonical: kitModelPath(brand.slug, entry.modelSlug) },
  };
}

/** The note for one kit after «Весь набор в корзину» came back (server/kits/add-handler.ts). */
function kitNotice(params: Record<string, string | string[] | undefined>) {
  const what = first(params.kit);
  const error = first(params.kit_error);
  if (what === 'changed') {
    return (
      <Notice tone="info" role="status" data-testid="kit-changed">
        Набор обновился, пока страница была открыта, — проверьте состав и нажмите ещё раз.
      </Notice>
    );
  }
  if (what === 'empty') {
    return (
      <Notice tone="wait" role="status" data-testid="kit-empty">
        Сейчас ни одной позиции набора нет у поставщика — попробуйте позже или подберём по VIN.
      </Notice>
    );
  }
  if (isCartErrorCode(error)) {
    return (
      <Notice tone="danger" role="alert" data-testid="kit-error">
        {CART_ERROR_MESSAGES[error]}
      </Notice>
    );
  }
  return null;
}

/**
 * /to/<make>/<model> (step 5, docs/kits.md): every published kit of the model as a section with
 * the kit's slug as its anchor, each line priced now (the supplier search through the shared
 * cache, priceOffer) and «Весь набор в корзину». A model without published kits is a 404.
 */
export default async function KitModelPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { make, model } = await params;
  const query = await searchParams;
  const brand = kitBrand(make);
  const entry = await modelOf(make, model);
  if (entry === undefined) throw new PageDataError('kits: catalogue unavailable');
  if (!brand || entry === null) notFound();
  const [views, gate] = await Promise.all([priceKitsNow(entry.kits), currentCheckoutGate()]);
  const phone = getBrand().contactPhone;
  const demo = entry.kits.some((kit) => kit.demo);
  const noteFor = first(query.for);
  const notice = kitNotice(query);
  return (
    <InnerPage>
      <PageBand
        tone="light"
        eyebrow={
          <span className="inline-flex flex-wrap items-center gap-x-2">
            <Link
              href={KITS_PATH}
              className="inline-flex min-h-11 items-center underline underline-offset-4"
            >
              Наборы для ТО
            </Link>
            <span aria-hidden>›</span>
            <Link
              href={kitMakePath(brand.slug)}
              className="inline-flex min-h-11 items-center underline underline-offset-4"
            >
              {brand.name}
            </Link>
          </span>
        }
        title={`ТО ${brand.name} ${entry.model}`}
        lead="Всё для планового ТО одной кнопкой. Цены — на сегодня."
        titleTestId="kit-model-title"
      >
        <div className="flex min-w-0 flex-col gap-4">
          {demo ? <KitsDemoNote /> : null}
          {views.length > 1 ? (
            <nav aria-label="Двигатели" className="flex min-w-0 flex-wrap gap-2">
              {views.map((view) => (
                <a
                  key={view.kit.id}
                  href={`#${view.kit.slug}`}
                  className="inline-flex min-h-11 items-center rounded-full border border-line-strong bg-bg px-4 text-small font-semibold hover:border-ink"
                >
                  {view.kit.engine}
                </a>
              ))}
            </nav>
          ) : null}
        </div>
      </PageBand>
      <PageBody className="space-y-14 md:space-y-20">
        {views.map((view) => (
          <KitSection
            key={view.kit.id}
            view={view}
            orderingOpen={gate.open}
            phone={phone}
            notice={noteFor === view.kit.slug ? notice : null}
          />
        ))}
        <CtaCard
          title="Другой двигатель или год?"
          titleId="kit-model-vin-cta"
          text="Мастер подберёт детали для ТО по VIN бесплатно."
          action={{
            href: vinRequestHref({ car: `${brand.name} ${entry.model}`, need: KIT_VIN_NEED }),
            label: 'Подобрать по VIN',
            icon: <IconSts size={22} />,
          }}
        />
      </PageBody>
    </InnerPage>
  );
}
