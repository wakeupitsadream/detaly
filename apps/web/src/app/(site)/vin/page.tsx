import type { Metadata } from 'next';
import { getBrand, telHref } from '@/server/brand';

export const metadata: Metadata = { title: 'Подбор запчастей по VIN' };

// Phase 0: no online form. Forms that collect personal data appear only after the
// notification to Roskomnadzor is registered (PLAN, decision 14).
export default function VinPage() {
  const brand = getBrand();
  const { pickup } = brand;
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold md:text-3xl">Подбор запчастей по VIN — бесплатно</h1>
      <p className="text-lg text-muted">
        Не знаете артикул? Мастер подберёт деталь под ваш автомобиль по VIN. Если подобрали мы и
        деталь не подошла к автомобилю из заявки — вернём деньги полностью.
      </p>

      <section className="space-y-3 rounded-card border border-line bg-card p-5">
        <h2 className="text-lg font-semibold">Как прислать запрос</h2>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Найдите VIN: 17 символов в свидетельстве о регистрации (СТС) или на табличке под лобовым
            стеклом.
          </li>
          <li>Позвоните или приезжайте в пункт выдачи: назовите VIN и какая деталь нужна.</li>
          <li>Мастер пришлёт варианты с ценой и датой получения.</li>
        </ol>
        <p className="text-sm text-muted">Онлайн-заявка на сайте появится позже.</p>
      </section>

      <section className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
        <div className="min-w-0 rounded-card border border-line bg-card p-5">
          <h2 className="font-semibold">Телефон</h2>
          {brand.contactPhone ? (
            <a
              className="mt-1 inline-block text-xl font-semibold text-accent-strong wrap-anywhere"
              href={telHref(brand.contactPhone)}
              data-testid="vin-phone"
            >
              {brand.contactPhone}
            </a>
          ) : (
            <p className="mt-1 text-muted">уточняется</p>
          )}
        </div>
        <div className="min-w-0 rounded-card border border-line bg-card p-5">
          <h2 className="font-semibold">Пункт выдачи{pickup.name ? ` «${pickup.name}»` : ''}</h2>
          <p className="mt-1 wrap-anywhere" data-testid="vin-address">
            {pickup.address ?? 'Адрес уточняется'}
          </p>
          {pickup.hours ? <p className="mt-1 text-sm text-muted">{pickup.hours}</p> : null}
        </div>
      </section>
    </div>
  );
}
