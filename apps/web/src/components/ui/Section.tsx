import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { Container } from './Container';

export type SectionTone = 'bg' | 'surface' | 'dark';

const TONE: Record<SectionTone, string> = {
  bg: 'bg-bg text-ink',
  surface: 'bg-surface text-ink',
  dark: 'bg-dark text-on-brand',
};

/**
 * A full-width band of a bleed page: tone, the 48 / 72 px rhythm and the site column inside.
 * `contained={false}` leaves the column to the caller; `spaced={false}` drops the rhythm.
 */
export function Section({
  tone = 'bg',
  contained = true,
  spaced = true,
  className,
  innerClassName,
  children,
  ...rest
}: {
  tone?: SectionTone;
  contained?: boolean;
  spaced?: boolean;
  innerClassName?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn('min-w-0', TONE[tone], spaced && 'section-y', className)} {...rest}>
      {contained ? <Container className={innerClassName}>{children}</Container> : children}
    </section>
  );
}

/**
 * Heading of a section (docs/design-v2.md, SectionHeading): the marker — a hairline across the
 * column with a 96 x 6 px brand bar on its left — and a bold `text-h2` title on the left.
 * `center` drops the marker and centres the title («Популярные категории»). `action` sits on
 * the right of the title (a «Все марки» link).
 */
export function SectionHeading({
  as: Tag = 'h2',
  id,
  center = false,
  onDark = false,
  action,
  className,
  children,
}: {
  as?: 'h1' | 'h2' | 'h3';
  id?: string;
  center?: boolean;
  /** On the dark panel: white title, no marker line. */
  onDark?: boolean;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  if (center) {
    return (
      <Tag
        id={id}
        className={cn('text-center text-h2 text-balance', onDark && 'text-on-brand', className)}
      >
        {children}
      </Tag>
    );
  }
  return (
    <div className={cn('min-w-0', className)}>
      {onDark ? null : (
        <div aria-hidden className="relative h-1.5">
          <div className="h-px bg-line" />
          <div className="absolute top-0 left-0 h-1.5 w-24 bg-brand" />
        </div>
      )}
      <div
        className={cn('flex min-w-0 items-end justify-between gap-4', !onDark && 'mt-5 md:mt-6')}
      >
        <Tag id={id} className={cn('min-w-0 text-h2', onDark && 'text-on-brand')}>
          {children}
        </Tag>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

/**
 * Root of a page that lays out its own full-width Sections (the home page): the storefront
 * <main> drops its column and padding for it (`.site-main:has([data-bleed])`).
 */
export function FullBleed({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-bleed="" className={cn('min-w-0', className)} {...rest} />;
}
