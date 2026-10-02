import Link from 'next/link';

export function EmptyState({ query }: { query: string }) {
  return (
    <div
      className="rounded-card border border-dashed border-line bg-card p-6 text-center"
      data-testid="empty-state"
    >
      <h2 className="text-lg font-semibold wrap-anywhere">По запросу «{query}» ничего не нашли</h2>
      <p className="mx-auto mt-2 max-w-md text-muted">
        Проверьте артикул: буквы и цифры с упаковки или из каталога. Если артикула нет, мастер
        подберёт деталь по VIN бесплатно.
      </p>
      <Link
        href="/vin"
        className="mt-4 inline-flex h-11 items-center rounded-xl bg-accent px-5 font-semibold text-white hover:bg-accent-strong"
      >
        Подобрать по VIN
      </Link>
    </div>
  );
}
