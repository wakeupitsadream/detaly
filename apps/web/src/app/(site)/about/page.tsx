import type { Metadata } from 'next';
import Link from 'next/link';
import { Requisites } from '@/components/Requisites';
import { getBrand } from '@/server/brand';

export const metadata: Metadata = { title: 'О сервисе' };

export default function AboutPage() {
  const brand = getBrand();
  const { pickup } = brand;
  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-3">
        <h1 className="text-2xl font-bold md:text-3xl">О сервисе {brand.name}</h1>
        <p className="text-lg text-muted">
          Мы продаём автозапчасти по артикулу и выдаём их в автосервисе, где деталь можно сразу
          установить. Не обещаем «самый большой ассортимент» — обещаем честную цену, точную дату и
          живого мастера, который поможет с подбором.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Что для вас меняется</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>Дата получения конкретным днём, а не «3–5 дней».</li>
          <li>Со склада в Оренбурге — оплата при получении.</li>
          <li>Под заказ — предоплата онлайн, чек приходит на телефон или e-mail.</li>
          <li>
            Возврат 7 дней без удержаний при самовывозе — подробно на странице{' '}
            <Link className="underline" href="/returns">
              «Возврат»
            </Link>
            .
          </li>
          <li>Бесплатный подбор по VIN живым мастером.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Пункт выдачи</h2>
        <p className="wrap-anywhere">
          {pickup.name ? `«${pickup.name}», ` : ''}
          {pickup.address ?? 'адрес уточняется'}
          {pickup.hours ? `. ${pickup.hours}` : ''}
        </p>
        <p className="text-sm text-muted">
          Установка — отдельная услуга автосервиса по его прайсу и чеку, на сайте она не
          оплачивается.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Реквизиты продавца</h2>
        <div className="rounded-card border border-line bg-card p-5">
          <Requisites brand={brand} />
        </div>
      </section>
    </div>
  );
}
