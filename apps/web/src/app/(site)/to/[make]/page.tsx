import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { IconSts } from '@/components/icons';
import { KitModelList, KitsDemoNote } from '@/components/kits/KitCatalog';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { CtaCard } from '@/components/ui/CtaCard';
import { SectionHeading } from '@/components/ui/Section';
import { KIT_VIN_NEED, kitMakePath, KITS_PATH } from '@/lib/kit-paths';
import { kitMakeSeo } from '@/lib/seo';
import { vinRequestHref } from '@/lib/vin-link';
import { PageDataError } from '@/server/errors';
import { kitBrand, kitModels, publishedKits } from '@/server/kits/catalog';

type Params = Promise<{ make: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { make } = await params;
  const brand = kitBrand(make);
  const models = kitModels((await publishedKits()) ?? [], make);
  if (!brand || models.length === 0) return {};
  const seo = kitMakeSeo(
    brand.name,
    models.map((entry) => entry.model),
  );
  return {
    title: seo.title,
    description: seo.description,
    alternates: { canonical: kitMakePath(brand.slug) },
  };
}

/**
 * /to/<make> (step 5, docs/kits.md): the models of a make with published kits, each with its
 * engines and years. A make without published kits is a 404.
 */
export default async function KitMakePage({ params }: { params: Params }) {
  const { make } = await params;
  const list = await publishedKits();
  if (list === null) throw new PageDataError('kits: catalogue unavailable');
  const brand = kitBrand(make);
  const models = kitModels(list, make);
  if (!brand || models.length === 0) notFound();
  const demo = models.some((entry) => entry.kits.some((kit) => kit.demo));
  return (
    <InnerPage>
      <PageBand
        tone="light"
        eyebrow={
          <Link
            href={KITS_PATH}
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Наборы для ТО
          </Link>
        }
        title={`ТО ${brand.name}`}
        lead="Выберите модель — в наборе всё для планового ТО."
        titleTestId="kit-make-title"
      >
        {demo ? <KitsDemoNote /> : null}
      </PageBand>
      <PageBody className="space-y-12 md:space-y-16">
        <section aria-labelledby="kit-models-title" className="min-w-0">
          <SectionHeading id="kit-models-title">Модели</SectionHeading>
          <div className="mt-5 md:mt-6">
            <KitModelList brand={brand} models={models} />
          </div>
        </section>
        <CtaCard
          title="Нет вашей модели?"
          titleId="kit-make-vin-cta"
          text="Мастер подберёт детали для ТО по VIN бесплатно."
          action={{
            href: vinRequestHref({ car: brand.name, need: KIT_VIN_NEED }),
            label: 'Подобрать по VIN',
            icon: <IconSts size={22} />,
          }}
        />
      </PageBody>
    </InnerPage>
  );
}
