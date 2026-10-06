import { IconHome, IconSearch, IconSts } from '@/components/icons';
import { ButtonLink } from '@/components/ui/Button';

/**
 * Root 404 (also prerendered at build time): no env, no database, so no brand name either —
 * a brand plate on top stands for the header. docs/design-v2.md, «Инфостраницы»: an icon,
 * «Страница не найдена», «На главную» and «Подбор по VIN».
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen min-w-0 flex-col bg-bg text-ink">
      <div aria-hidden className="h-6 rounded-b-header bg-brand lg:h-8 lg:rounded-b-header-lg" />
      <div className="mx-auto flex w-full max-w-site flex-1 flex-col items-center justify-center px-4 py-16 text-center md:px-6 lg:px-8">
        <span
          aria-hidden
          className="relative grid size-28 place-items-center rounded-full bg-surface text-brand md:size-32"
        >
          <IconSearch size={64} strokeWidth={1.5} />
        </span>
        <p className="mt-6 text-small font-semibold text-muted tabular-nums">Ошибка 404</p>
        <h1 className="mt-2 text-h1">Страница не найдена</h1>
        <p className="mt-3 max-w-md text-body text-muted">Ссылка устарела или в адресе опечатка.</p>
        <div className="mt-8 flex w-full max-w-md flex-col gap-3 sm:w-auto sm:max-w-none sm:flex-row">
          <ButtonLink href="/" size="lg" icon={<IconHome size={20} />}>
            На главную
          </ButtonLink>
          <ButtonLink
            href="/vin"
            variant="secondary"
            size="lg"
            icon={<IconSts size={20} className="text-brand" />}
          >
            Подбор по VIN
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}
