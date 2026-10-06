import type { Metadata } from 'next';
import Link from 'next/link';
import {
  IconCalendar,
  IconClock,
  IconLift,
  IconPhone,
  IconPin,
  IconReturn,
  IconSts,
  IconWallet,
} from '@/components/icons';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { PickupRouteLinks } from '@/components/PickupRouteLinks';
import { Requisites } from '@/components/Requisites';
import { InfoCard } from '@/components/ui/Card';
import { FeatureRow } from '@/components/ui/FeatureRow';
import { SectionHeading } from '@/components/ui/Section';
import { getBrand, telHref } from '@/server/brand';

export const metadata: Metadata = { title: 'О сервисе' };

const LINK =
  'font-semibold text-brand underline decoration-1 underline-offset-4 hover:text-brand-hover hover:decoration-2';

/**
 * /about (docs/design-v2.md, «Инфостраницы»): the pickup point on top (anchor #pickup, the
 * header links «Как добраться» here) with the partner's colour logo from env, four advantages
 * as FeatureRows, the seller's requisites.
 */
export default function AboutPage() {
  const brand = getBrand();
  const { pickup } = brand;
  const logo = brand.pickupLogo?.color ?? null;
  return (
    <InnerPage>
      <PageBand
        tone="light"
        title={`О сервисе ${brand.name}`}
        lead="Запчасти по артикулу с точной датой. Забираете и ставите в одном месте."
      />
      <PageBody className="space-y-12 md:space-y-16">
        <InfoCard
          id="pickup"
          title="Точка выдачи"
          titleId="about-pickup"
          aria-labelledby="about-pickup"
          icon={<IconPin size={40} strokeWidth={1.5} />}
          className="scroll-mt-28"
        >
          <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-10">
            <div className="min-w-0 space-y-5">
              {pickup.name ? <p className="text-h3 wrap-anywhere">{pickup.name}</p> : null}
              <ul className="space-y-3 text-body">
                <li className="flex items-start gap-3">
                  <IconPin size={24} className="mt-0.5 shrink-0 text-brand" />
                  <span className="min-w-0 font-semibold wrap-anywhere">
                    {pickup.address ?? 'Адрес уточняется'}
                  </span>
                </li>
                {pickup.hours ? (
                  <li className="flex items-start gap-3">
                    <IconClock size={24} className="mt-0.5 shrink-0 text-brand" />
                    <span className="min-w-0">{pickup.hours}</span>
                  </li>
                ) : null}
                {pickup.phone ? (
                  <li className="flex items-start gap-3">
                    <IconPhone size={24} className="mt-0.5 shrink-0 text-brand" />
                    <a
                      className="font-semibold whitespace-nowrap tabular-nums underline-offset-4 hover:text-brand hover:underline"
                      href={telHref(pickup.phone)}
                    >
                      {pickup.phone}
                    </a>
                  </li>
                ) : null}
                <li className="flex items-start gap-3 text-muted">
                  <IconLift size={24} className="mt-0.5 shrink-0 text-brand" />
                  <span className="min-w-0">Установка — у сервиса, по его прайсу и чеку.</span>
                </li>
              </ul>
              <PickupRouteLinks brand={brand} />
            </div>
            {logo ? (
              <div className="grid place-items-center rounded-tile bg-bg p-4 max-md:order-first md:size-64">
                {/* A plain img: a small WebP from public/, no optimizer needed. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logo}
                  alt={pickup.name ? `Логотип ${pickup.name}` : 'Логотип точки выдачи'}
                  width={320}
                  height={280}
                  className="h-auto w-36 md:w-56"
                />
              </div>
            ) : null}
          </div>
        </InfoCard>

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
