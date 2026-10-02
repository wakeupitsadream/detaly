import type { Brand } from '@/server/brand';
import { telHref } from '@/server/brand';
import { Requisites } from './Requisites';

/** Pickup point with a photo placeholder (the real photo comes with the first deploy). */
export function TrustBlock({ brand }: { brand: Brand }) {
  const { pickup } = brand;
  return (
    <section
      aria-labelledby="trust-title"
      className="grid min-w-0 grid-cols-1 gap-5 rounded-card border border-line bg-card p-5 md:grid-cols-2 md:p-6"
    >
      <div
        className="flex aspect-[4/3] w-full min-w-0 flex-col items-center justify-center rounded-xl border border-dashed border-line bg-paper text-center text-faint"
        role="img"
        aria-label="Фото пункта выдачи появится здесь"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-10 w-10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 7h3l2-3h8l2 3h3v12H3z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
        <span className="mt-2 text-sm">Фото пункта выдачи</span>
      </div>
      <div className="min-w-0">
        <h2 id="trust-title" className="text-xl font-semibold">
          Запчасти от людей, которые их же и поставят
        </h2>
        <p className="mt-2 text-muted">
          Пункт выдачи — в автосервисе{pickup.name ? ` «${pickup.name}»` : ''}. Продавец —
          индивидуальный предприниматель с реквизитами ниже, возврат 7 дней без удержаний при
          самовывозе.
        </p>
        <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <dt className="text-muted">Адрес</dt>
          <dd className="min-w-0 wrap-anywhere">{pickup.address ?? 'уточняется'}</dd>
          <dt className="text-muted">Часы</dt>
          <dd className="min-w-0 wrap-anywhere">{pickup.hours ?? 'уточняются'}</dd>
          <dt className="text-muted">Телефон</dt>
          <dd className="min-w-0 wrap-anywhere">
            {brand.contactPhone ? (
              <a className="underline" href={telHref(brand.contactPhone)}>
                {brand.contactPhone}
              </a>
            ) : (
              'уточняется'
            )}
          </dd>
        </dl>
        <div className="mt-4 border-t border-line pt-4">
          <Requisites brand={brand} compact />
        </div>
      </div>
    </section>
  );
}
