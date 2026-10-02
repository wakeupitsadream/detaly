'use client';

import { IconAlert } from '@/components/icons';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Eyebrow } from '@/components/ui/Eyebrow';

export default function SiteError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Card corners className="max-w-xl space-y-4">
      <Eyebrow>Сбой страницы</Eyebrow>
      <h1 className="text-h1 flex items-start gap-3">
        <IconAlert size={32} className="mt-1 shrink-0 text-danger" />
        Что-то пошло не так
      </h1>
      <p className="text-muted">
        Страница не загрузилась. Попробуйте ещё раз через минуту — мы уже знаем о проблеме.
      </p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Button onClick={reset}>Повторить</Button>
        <ButtonLink href="/" variant="ghost">
          На главную
        </ButtonLink>
      </div>
    </Card>
  );
}
