import type { Metadata } from 'next';
import Link from 'next/link';
import {
  IconCalendar,
  IconReceipt,
  IconReturn,
  IconSts,
  IconWallet,
  IconWrench,
} from '@/components/icons';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { PickupCard } from '@/components/PickupCard';
import { pickupRoutes } from '@/components/PickupRouteLinks';
import { Requisites } from '@/components/Requisites';
import { FeatureRow } from '@/components/ui/FeatureRow';
import { SectionHeading } from '@/components/ui/Section';
import { aboutDescription, PAGE_SEO } from '@/lib/seo';
import { getBrand } from '@/server/brand';

/** The description names the pickup point, its address and hours from env (lib/seo.ts). */
export function generateMetadata(): Metadata {
  return {
    title: PAGE_SEO.about.title,
    description: aboutDescription(getBrand().pickup),
    alternates: { canonical: '/about' },
  };
}

/**
 * A page link at the end of a feature line. py-3: an inline box grows its target to 47 px
 * without moving the line (like «Например, OC 90» in the header).
 */
const LINK =
  'py-3 font-semibold text-brand underline decoration-1 underline-offset-4 hover:text-brand-hover hover:decoration-2';

/**
 * /about (docs/design-v2.md, «Инфостраницы»): the shop in one line — an independent auto parts
 * store whose orders are handed over at the service named in env, installation there being the
 * service's own optional job (decision of 08.10); the pickup point on top (anchor #pickup, the
 * header links «Как добраться» here; the shared PickupCard, the point named in text), five
 * advantages as FeatureRows, the seller's requisites.
 */
export default function AboutPage() {
  const brand = getBrand();
  const { pickup } = brand;
  return (
    <InnerPage>
      <PageBand
        tone="light"
        title={`О магазине ${brand.name}`}
        lead={
          <>
            Независимый магазин автозапчастей. Выдача — в{'\u00a0'}автосервисе
            {pickup.name ? ` ${pickup.name}` : ''}, установка по{'\u00a0'}желанию — услуга сервиса,
            оплачивается там.
          </>
        }
      />
      <PageBody className="space-y-12 md:space-y-16">
        <PickupCard
          id="pickup"
          title="Пункт выдачи"
          titleId="about-pickup"
          pickup={pickup}
          phone={brand.contactPhone}
          routes={pickupRoutes(brand)}
          logo={brand.pickupLogo?.color ?? null}
          extra={
            <p className="flex min-w-0 items-start gap-3 text-body text-muted">
              <IconWrench size={24} className="mt-0.5 shrink-0 text-brand" />
              <span className="min-w-0">Установка — у сервиса, по его прайсу и чеку.</span>
            </p>
          }
        />

        <div className="grid min-w-0 gap-12 lg:grid-cols-[minmax(0,1fr)_26rem] lg:gap-16">
          <section aria-labelledby="about-why" className="min-w-0">
            <SectionHeading id="about-why">Почему у нас</SectionHeading>
            <ul className="mt-8 space-y-7">
              <FeatureRow as="li" icon={<IconCalendar size={40} />} title="Точная дата">
                Видна ещё до заказа — не «3–5 дней».
              </FeatureRow>
              <FeatureRow as="li" icon={<IconWallet size={40} />} title="Оплата при получении">
                Для деталей со склада в Оренбурге. Под заказ — предоплата.
              </FeatureRow>
              <FeatureRow as="li" icon={<IconSts size={40} />} title="Подбор по VIN бесплатно">
                Живой мастер.{' '}
                <Link className={LINK} href="/vin">
                  Прислать VIN
                </Link>
              </FeatureRow>
              <FeatureRow as="li" icon={<IconReturn size={40} />} title="Возврат 7 дней">
                Без удержаний при самовывозе.{' '}
                <Link className={LINK} href="/returns">
                  Как вернуть
                </Link>
              </FeatureRow>
              {/* The dark panel's «Чек на каждую покупку» leads here. */}
              <FeatureRow as="li" icon={<IconReceipt size={40} />} title="Чек на каждую покупку">
                Кассовый чек — для гарантии и возврата.
              </FeatureRow>
            </ul>
          </section>

          <section aria-labelledby="about-requisites" className="min-w-0">
            <SectionHeading id="about-requisites">Реквизиты</SectionHeading>
            <div className="mt-8 min-w-0 rounded-tile border border-line p-5 md:p-6">
              <Requisites brand={brand} />
            </div>
          </section>
        </div>
      </PageBody>
    </InnerPage>
  );
}
