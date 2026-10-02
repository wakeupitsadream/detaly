import { DemoDataBanner } from './DemoDataBanner';
import { IconArrowRight, IconSearch } from './icons';
import { ButtonLink } from './ui/Button';

const TIPS = [
  ['На старой детали', 'выбит или напечатан на корпусе, рядом с логотипом бренда'],
  ['В заказ-наряде', 'сервис пишет артикул каждой детали, которую ставил'],
  ['В каталоге производителя', 'по марке, модели и году выпуска'],
] as const;

/** Nothing found: what to check, where articles are written, and the VIN selection. */
export function EmptyState({ query, demoData = false }: { query: string; demoData?: boolean }) {
  return (
    <div
      className="grid min-w-0 gap-6 rounded border border-line bg-card p-5 md:grid-cols-[auto_minmax(0,1fr)] md:gap-8 md:p-8"
      data-testid="empty-state"
    >
      <div
        aria-hidden
        className="grid size-16 place-items-center rounded bg-graphite-800 bg-tread text-steel-200 md:size-24"
      >
        <IconSearch size={32} />
      </div>
      <div className="min-w-0">
        <h2 className="text-h2 text-balance wrap-anywhere">По запросу «{query}» ничего не нашли</h2>
        <p className="mt-3 max-w-xl text-muted">
          Проверьте артикул: буквы и цифры с упаковки или из каталога. Если артикула нет, мастер
          подберёт деталь по VIN бесплатно.
        </p>
        <dl className="mt-5 mb-5 grid gap-px overflow-hidden rounded-sm border border-line bg-line sm:grid-cols-3">
          {TIPS.map(([title, text]) => (
            <div key={title} className="min-w-0 bg-paper px-4 py-3">
              <dt className="text-sm font-semibold">{title}</dt>
              <dd className="mt-0.5 text-sm text-muted">{text}</dd>
            </div>
          ))}
        </dl>
        {demoData ? <DemoDataBanner /> : null}
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
          <ButtonLink href="/vin">
            Подобрать по VIN
            <IconArrowRight size={18} />
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
