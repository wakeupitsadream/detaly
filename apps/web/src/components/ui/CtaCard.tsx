import type { ReactNode } from 'react';
import { ButtonLink } from './Button';
import { cn } from './cn';

/**
 * «Не знаете артикул?» (docs/design-v2.md, CtaCard): `bg-surface rounded-panel`, a `text-h2`
 * title, one sentence and a brand button across the card on phones (its own width from md).
 * `action` takes a ready href and label; `children` replaces the button with anything else.
 * `art` is a picture on a white plate to the right from lg, so a card across the whole
 * container never leaves an empty grey field beside a short text (hidden on phones).
 */
export function CtaCard({
  title,
  titleAs: Title = 'h2',
  titleId,
  text,
  icon,
  art,
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
  /** A picture to the right from lg (VinCtaArt for the VIN cards). */
  art?: ReactNode;
  action?: { href: string; label: ReactNode; icon?: ReactNode; prefetch?: boolean };
  className?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-panel bg-surface p-6 text-ink md:p-10',
        art != null && 'lg:grid lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-12',
        className,
      )}
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <div className="min-w-0">
        <CtaBody
          title={title}
          Title={Title}
          titleId={titleId}
          text={text}
          icon={icon}
          action={action}
        >
          {children}
        </CtaBody>
      </div>
      {art ? <div className="hidden lg:block">{art}</div> : null}
    </section>
  );
}

function CtaBody({
  title,
  Title,
  titleId,
  text,
  icon,
  action,
  children,
}: {
  title: ReactNode;
  Title: 'h1' | 'h2' | 'h3';
  titleId?: string;
  text?: ReactNode;
  icon?: ReactNode;
  action?: { href: string; label: ReactNode; icon?: ReactNode; prefetch?: boolean };
  children?: ReactNode;
}) {
  return (
    <>
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
    </>
  );
}
