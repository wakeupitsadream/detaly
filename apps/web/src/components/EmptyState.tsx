import { vinRequestHref } from '@/lib/vin-link';
import { DemoDataBanner } from './DemoDataBanner';
import { IconSearch, IconSts } from './icons';
import { EmptyPanel } from './page/EmptyPanel';
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
    <EmptyPanel
      icon={<IconSearch size={64} />}
      titleAs="h1"
      titleId="empty-title"
      testId="empty-state"
      title={<>Ничего не нашли по «{query}»</>}
      text={
        <>
          {/* No-break space: the dash never starts the second line. */}
          Проверьте артикул или пришлите VIN{'\u00a0'}— мастер подберёт деталь бесплатно.
        </>
      }
      actions={
        <>
          {/* The article goes into the request: nothing to remember and type again. */}
          <ButtonLink
            href={vinRequestHref({ need: `Артикул ${query}` })}
            size="lg"
            icon={<IconSts size={22} />}
          >
            Подобрать по VIN
          </ButtonLink>
          <EditQueryLink className={cn(buttonClass({ variant: 'secondary', size: 'lg' }), 'bg-bg')}>
            <IconSearch size={22} />
            Изменить запрос
          </EditQueryLink>
        </>
      }
    >
      {demoData ? <DemoDataBanner stacked className="mt-8" /> : null}
    </EmptyPanel>
  );
}
