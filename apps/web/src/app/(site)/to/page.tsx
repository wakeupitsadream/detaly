import type { Metadata } from 'next';
import { IconBox, IconSts } from '@/components/icons';
import { KitMakeGrid, KitsDemoNote } from '@/components/kits/KitCatalog';
import { EmptyPanel } from '@/components/page/EmptyPanel';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { ButtonLink } from '@/components/ui/Button';
import { CtaCard } from '@/components/ui/CtaCard';
import { SectionHeading } from '@/components/ui/Section';
import { KIT_VIN_NEED, KITS_PATH } from '@/lib/kit-paths';
import { KITS_SEO } from '@/lib/seo';
import { vinRequestHref } from '@/lib/vin-link';
import { PageDataError } from '@/server/errors';
import { kitMakes, publishedKits } from '@/server/kits/catalog';

export async function generateMetadata(): Promise<Metadata> {
  const list = await publishedKits();
  const empty = kitMakes(list ?? []).length === 0;
  return {
    title: KITS_SEO.title,
    description: KITS_SEO.description,
    alternates: { canonical: KITS_PATH },
    // Nothing to show yet: not worth a search engine's visit.
    ...(empty ? { robots: { index: false, follow: true } } : {}),
  };
}

/**
 * /to (step 5, docs/kits.md): the makes with published maintenance kits, as logo cards leading
 * to /to/<make>; without kits, a prompt for the VIN request instead. The demo's samples say so.
 */
export default async function KitsPage() {
  const list = await publishedKits();
  if (list === null) throw new PageDataError('kits: catalogue unavailable');
  const makes = kitMakes(list);
  const demo = list.some((kit) => kit.demo);
  return (
    <InnerPage>
      <PageBand
        tone="light"
        title="Наборы для ТО"
        lead="Фильтры, свечи и другие детали для ТО — одной кнопкой в корзину."
        titleTestId="kits-title"
      >
        {demo ? <KitsDemoNote /> : null}
      </PageBand>
      <PageBody className="space-y-12 md:space-y-16">
        {makes.length > 0 ? (
          <section aria-labelledby="kit-makes-title" className="min-w-0">
            <SectionHeading id="kit-makes-title">Выберите марку</SectionHeading>
            <div className="mt-5 md:mt-6">
              <KitMakeGrid makes={makes} />
            </div>
            <p className="mt-4 text-caption font-normal text-muted md:mt-5">
              Товарные знаки принадлежат их владельцам. Мы не официальный дилер марок.
            </p>
          </section>
        ) : (
          <EmptyPanel
            icon={<IconBox size={64} />}
            title="Наборов пока нет"
            testId="kits-empty"
            text="Мастер подберёт детали для ТО по VIN — бесплатно."
            actions={
              <ButtonLink
                href={vinRequestHref({ need: KIT_VIN_NEED })}
                size="lg"
                icon={<IconSts size={22} />}
              >
                Подобрать по VIN
              </ButtonLink>
            }
          />
        )}
        {makes.length > 0 ? (
          <CtaCard
            title="Нет вашей машины?"
            titleId="kits-vin-cta"
            text="Мастер подберёт детали для ТО по VIN бесплатно."
            action={{
              href: vinRequestHref({ need: KIT_VIN_NEED }),
              label: 'Подобрать по VIN',
              icon: <IconSts size={22} />,
            }}
            testId="kits-vin-cta"
          />
        ) : null}
      </PageBody>
    </InnerPage>
  );
}
