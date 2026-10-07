import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

/**
 * One look for every «nothing here» screen (empty search, empty cart, 404): a grey card at most
 * 36rem wide in the middle, a 64 px brand icon in a white circle, the title, one line and the
 * buttons — side by side at their own width from md, full width one under another on phones.
 */
export function EmptyPanel({
  icon,
  title,
  titleAs: Title = 'h2',
  titleId,
  eyebrow,
  text,
  actions,
  children,
  testId,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  titleAs?: 'h1' | 'h2';
  titleId?: string;
  /** A small muted line over the title («Ошибка 404»). */
  eyebrow?: ReactNode;
  text?: ReactNode;
  actions?: ReactNode;
  /** Under the buttons (the demo note of the empty search). */
  children?: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'mx-auto flex w-full max-w-[36rem] min-w-0 flex-col items-center rounded-panel bg-surface px-5 py-10 text-center md:px-10 md:py-14',
        className,
      )}
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <div aria-hidden className="grid size-24 place-items-center rounded-full bg-bg text-brand">
        {icon}
      </div>
      {eyebrow ? (
        <p className="mt-6 text-small font-semibold text-muted tabular-nums">{eyebrow}</p>
      ) : null}
      <Title
        id={titleId}
        className={cn('text-h2 text-balance wrap-anywhere', eyebrow ? 'mt-2' : 'mt-6')}
      >
        {title}
      </Title>
      {text ? <p className="mt-3 text-body text-balance text-muted">{text}</p> : null}
      {actions ? (
        <div className="mt-8 flex w-full flex-col gap-3 *:w-full md:w-auto md:flex-row md:justify-center md:*:w-auto">
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}
