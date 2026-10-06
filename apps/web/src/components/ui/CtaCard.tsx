import type { ReactNode } from 'react';
import { ButtonLink } from './Button';
import { cn } from './cn';

/**
 * «Не знаете артикул?» (docs/design-v2.md, CtaCard): `bg-surface rounded-panel`, a `text-h2`
 * title, one sentence and a brand button across the card on phones (its own width from md).
 * `action` takes a ready href and label; `children` replaces the button with anything else.
 */
export function CtaCard({
  title,
  titleAs: Title = 'h2',
  titleId,
  text,
  icon,
  action,
  className,
  testId,
  children,
}: {
  title: ReactNode;
  titleAs?: 'h1' | 'h2' | 'h3';
  titleId?: string;
  text?: ReactNode;
  /** A large icon over the title (the lock of the closed checkout). */
  icon?: ReactNode;
  action?: { href: string; label: ReactNode; icon?: ReactNode; prefetch?: boolean };
  className?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <section
      className={cn('min-w-0 rounded-panel bg-surface p-6 text-ink md:p-10', className)}
      aria-labelledby={titleId}
      data-testid={testId}
    >
      {icon ? <div className="mb-4 text-brand">{icon}</div> : null}
      <Title id={titleId} className="text-h2">
        {title}
      </Title>
      {text ? <p className="mt-3 max-w-2xl text-body text-muted">{text}</p> : null}
      {action ? (
        <ButtonLink
          href={action.href}
          prefetch={action.prefetch}
          icon={action.icon}
          size="lg"
          className="mt-6 w-full md:w-auto md:min-w-64"
        >
          {action.label}
        </ButtonLink>
      ) : null}
      {children ? <div className="mt-6 min-w-0">{children}</div> : null}
    </section>
  );
}
