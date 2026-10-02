import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { IconClock, IconLift, IconPhone, IconPin } from '@/components/icons';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { SheetTitle } from '@/components/page/SheetTitle';
import { Requisites } from '@/components/Requisites';
import { getBrand, telHref } from '@/server/brand';

export const metadata: Metadata = { title: 'О сервисе' };

const LINK =
  'font-medium text-accent-ink underline decoration-1 underline-offset-4 hover:decoration-2';

/** What changes for the client, as rows of a spec sheet. */
const ROWS: readonly { title: string; text: ReactNode }[] = [
  {
    title: 'Дата, а не «3–5 дней»',
    text: 'Дату получения называем конкретным днём — и видно её ещё до заказа.',
  },
  {
    title: 'Со склада в Оренбурге',
    text: 'Оплата при получении: смотрите деталь и только потом платите.',
  },
  {
    title: 'Под заказ',
    text: 'Предоплата онлайн, чек приходит на телефон или e-mail.',
  },
  {
    title: 'Возврат 7 дней',
    text: (
      <>
        Без удержаний при самовывозе — подробно на странице{' '}
        <Link className={LINK} href="/returns">
          «Возврат»
        </Link>
        .
      </>
    ),
  },
  {
    title: 'Подбор по VIN',
    text: (
      <>
        Бесплатно, живым мастером.{' '}
        <Link className={LINK} href="/vin">
          Как прислать запрос
        </Link>
      </>
    ),
  },
];

export default function AboutPage() {
  const brand = getBrand();
  const { pickup } = brand;
  return (
    <InnerPage>
      <PageBand
        eyebrow="Оренбург · автозапчасти с установкой"
        title={`О сервисе ${brand.name}`}
        lead="Мы продаём автозапчасти по артикулу и выдаём их в автосервисе, где деталь можно сразу установить. Не обещаем «самый большой ассортимент» — обещаем честную цену, точную дату и живого мастера, который поможет с подбором."
      />
      <PageBody>
        <div className="grid min-w-0 gap-12 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-16">
          <section aria-labelledby="about-changes" className="min-w-0">
            <h2 id="about-changes" className="text-h2">
              Что для вас меняется
            </h2>
            <ol className="mt-6 border-t border-ink md:mt-8">
              {ROWS.map((row, index) => (
                <li
                  key={row.title}
                  className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 border-b border-line py-5 md:grid-cols-[3rem_14rem_minmax(0,1fr)] md:gap-x-6 md:py-6"
                >
                  <span className="pt-0.5 font-mono text-xs font-semibold text-accent-ink">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <h3 className="text-h3">{row.title}</h3>
                  <p className="col-start-2 mt-1 text-muted md:col-start-3 md:mt-0">{row.text}</p>
                </li>
              ))}
            </ol>
          </section>

          <div className="min-w-0 space-y-6">
            <section
              aria-labelledby="about-pickup"
              className="grain-dark min-w-0 rounded border border-graphite-700 bg-graphite-900 bg-blueprint p-5 text-steel-200 md:p-6"
            >
              <p className="text-label text-steel-400">Пункт выдачи</p>
              <h2
                id="about-pickup"
                className="mt-2 font-display text-lg leading-snug font-semibold text-paper wrap-anywhere"
              >
                {pickup.name ?? 'Автосервис-партнёр'}
              </h2>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li className="flex items-start gap-2.5">
                  <IconPin size={17} className="mt-0.5 shrink-0 text-accent" />
                  <span className="min-w-0 wrap-anywhere">
                    {pickup.address ?? 'адрес уточняется'}
                  </span>
                </li>
                {pickup.hours ? (
                  <li className="flex items-start gap-2.5">
                    <IconClock size={17} className="mt-0.5 shrink-0 text-steel-400" />
                    <span className="min-w-0">{pickup.hours}</span>
                  </li>
                ) : null}
                {pickup.phone ? (
                  <li className="flex items-start gap-2.5">
                    <IconPhone size={17} className="mt-0.5 shrink-0 text-steel-400" />
                    <a
                      className="text-paper underline underline-offset-4"
                      href={telHref(pickup.phone)}
                    >
                      {pickup.phone}
                    </a>
                  </li>
                ) : null}
              </ul>
              <p className="mt-5 flex items-start gap-2.5 border-t border-graphite-700 pt-4 text-sm text-steel-400">
                <IconLift size={17} className="mt-0.5 shrink-0" />
                Установка — отдельная услуга автосервиса по его прайсу и чеку, на сайте она не
                оплачивается.
              </p>
            </section>

            <section
              aria-labelledby="about-requisites"
              className="corner-marks min-w-0 rounded border border-ink bg-card p-5 md:p-6"
            >
              <SheetTitle id="about-requisites">Реквизиты продавца</SheetTitle>
              <Requisites brand={brand} />
            </section>
          </div>
        </div>
      </PageBody>
    </InnerPage>
  );
}
