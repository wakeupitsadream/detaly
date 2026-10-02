import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { Container } from './Container';

export type SectionTone = 'paper' | 'sunken' | 'dark' | 'darker';

const TONE: Record<SectionTone, string> = {
  paper: 'bg-paper text-ink',
  sunken: 'bg-paper-2 text-ink',
  dark: 'bg-graphite-900 text-steel-200 grain-dark',
  darker: 'bg-graphite-950 text-steel-200 grain-dark',
};

/**
 * A full-width band of a bleed page: tone, optional drafting grid, the 56/88/120 px rhythm and
 * the site column inside. `contained={false}` leaves the column to the caller; `spaced={false}`
 * drops the vertical rhythm (a hero sets its own).
 */
export function Section({
  tone = 'paper',
  blueprint = false,
  contained = true,
  spaced = true,
  className,
  innerClassName,
  children,
  ...rest
}: {
  tone?: SectionTone;
  blueprint?: boolean;
  contained?: boolean;
  spaced?: boolean;
  innerClassName?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        'min-w-0',
        TONE[tone],
        blueprint && 'bg-blueprint',
        spaced && 'section-y',
        className,
      )}
      {...rest}
    >
      {contained ? <Container className={innerClassName}>{children}</Container> : children}
    </section>
  );
}

/**
 * Root of a page that lays out its own full-width Sections (the home page): the storefront
 * <main> drops its column and padding for it (`.site-main:has([data-bleed])`).
 */
export function FullBleed({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-bleed="" className={cn('min-w-0', className)} {...rest} />;
}
