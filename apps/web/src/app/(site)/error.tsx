'use client';

import { IconAlert, IconHome } from '@/components/icons';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';

/**
 * Error boundary of the storefront pages, in the 404's look (docs/design-v2.md, «Инфостраницы»):
 * an icon, one heading, one sentence, «Повторить» and «На главную». The header and footer of
 * the site layout stay around it.
 */
export default function SiteError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Container className="flex flex-col items-center py-16 text-center">
      <span
        aria-hidden
        className="grid size-28 place-items-center rounded-full bg-danger-soft text-danger md:size-32"
      >
        <IconAlert size={64} strokeWidth={1.5} />
      </span>
      <h1 className="mt-6 text-h1">Что-то пошло не так</h1>
      <p className="mt-3 max-w-md text-body text-muted">
        Страница не загрузилась. Попробуйте ещё раз через минуту.
      </p>
      <div className="mt-8 flex w-full max-w-md flex-col gap-3 sm:w-auto sm:max-w-none sm:flex-row">
        <Button onClick={reset} size="lg">
          Повторить
        </Button>
        <ButtonLink href="/" variant="secondary" size="lg" icon={<IconHome size={20} />}>
          На главную
        </ButtonLink>
      </div>
    </Container>
  );
}
