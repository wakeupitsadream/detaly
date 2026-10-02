import Link from 'next/link';

export function VinCta() {
  return (
    <section className="rounded-card border border-line bg-accent-soft p-5 md:flex md:items-center md:justify-between md:gap-6 md:p-6">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">
          Не знаете артикул? Пришлите VIN — подберём бесплатно
        </h2>
        <p className="mt-1 text-muted">
          Мастер подберёт деталь под ваш автомобиль. Подобрали мы и не подошло — вернём деньги.
        </p>
      </div>
      <Link
        href="/vin"
        className="mt-4 inline-flex h-11 shrink-0 items-center rounded-xl border border-accent px-5 font-semibold text-accent-strong hover:bg-white md:mt-0"
      >
        Как прислать VIN
      </Link>
    </section>
  );
}
