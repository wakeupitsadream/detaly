import { DemoDataBanner } from './DemoDataBanner';
import { IconSearch, IconSts } from './icons';
import { EditQueryLink } from './search/EditQueryLink';
import { buttonClass, ButtonLink } from './ui/Button';
import { cn } from './ui/cn';

/**
 * Nothing found (docs/design-v2.md, «Поиск»): a 64 px magnifier, «Ничего не нашли по „…“», one
 * line, «Подобрать по VIN» and «Изменить запрос» (the caret into the header search). In the
 * demo the one-line note with the articles that answer.
 */
export function EmptyState({ query, demoData = false }: { query: string; demoData?: boolean }) {
  return (
    <section
      className="flex min-w-0 flex-col items-center rounded-panel bg-surface px-5 py-10 text-center md:px-10 md:py-14"
      aria-labelledby="empty-title"
      data-testid="empty-state"
    >
      <div aria-hidden className="grid size-24 place-items-center rounded-full bg-bg text-brand">
        <IconSearch size={64} strokeWidth={1.5} />
      </div>
      <h1 id="empty-title" className="mt-6 max-w-2xl text-h1 text-balance wrap-anywhere">
        Ничего не нашли по «{query}»
      </h1>
      <p className="mt-3 max-w-xl text-body text-balance text-muted">
        {/* No-break space: the dash never starts the second line. */}
        Проверьте артикул или пришлите VIN{'\u00a0'}— мастер подберёт деталь бесплатно.
      </p>
      <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
        <ButtonLink href="/vin" size="lg" icon={<IconSts size={22} />}>
          Подобрать по VIN
        </ButtonLink>
        <EditQueryLink className={cn(buttonClass({ variant: 'secondary', size: 'lg' }), 'bg-bg')}>
          <IconSearch size={22} />
          Изменить запрос
        </EditQueryLink>
      </div>
      {demoData ? <DemoDataBanner stacked className="mt-8" /> : null}
    </section>
  );
}
