import type { ReactNode } from 'react';
import { Container } from '@/components/ui/Container';
import { FullBleed } from '@/components/ui/Section';
import { cn } from '@/components/ui/cn';

/** @deprecated «Техкарта» drafting rule; now a plain hairline. */
export function Ruler({ className }: { onDark?: boolean; className?: string }) {
  return <div aria-hidden className={cn('h-px w-full bg-line', className)} />;
}

/**
 * Title of an inner page: a quiet caption (`eyebrow`), the `text-h1`, one sentence of lead in
 * muted text and whatever the page puts under it (the order stepper, filter chips). `meta` is
 * the right column from md (checkout steps, a document's edition). The page below it is laid
 * out by PageBody.
 *
 * Redesigned pages pass `tone="light"` (white, the v2 look). The default `dark` keeps pages that
 * are not restyled yet readable: their children still paint light text for the old graphite
 * band. It goes away once every page package is merged (docs/design-v2.md, section 7).
 */
export function PageBand({
  tone = 'dark',
  eyebrow,
  title,
  lead,
  meta,
  titleTestId,
  children,
  className,
  compactOnPhone = false,
}: {
  /** `light` is the v2 look; `dark` is the compatibility default for pages not restyled yet. */
  tone?: 'light' | 'dark';
  /** Below md: no caption and less air, so the content (search results) starts sooner. */
  compactOnPhone?: boolean;
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  meta?: ReactNode;
  titleTestId?: string;
  children?: ReactNode;
  className?: string;
}) {
  const dark = tone === 'dark';
  return (
    <section
      className={cn(
        dark ? 'bg-dark pb-6 text-on-brand md:pb-10 print:bg-bg print:text-ink' : 'bg-bg text-ink',
        className,
      )}
    >
      <Container className={cn(compactOnPhone ? 'pt-5' : 'pt-6', 'md:pt-10')}>
        <div className="flex min-w-0 flex-col gap-x-10 gap-y-4 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0 md:max-w-3xl">
            {eyebrow ? (
              <p
                className={cn(
                  'mb-2 text-small font-semibold',
                  dark ? 'text-on-brand/75' : 'text-muted',
                  compactOnPhone && 'max-md:hidden',
                )}
              >
                {eyebrow}
              </p>
            ) : null}
            <h1 className="text-h1 text-balance" data-testid={titleTestId}>
              {title}
            </h1>
            {lead ? (
              <p
                className={cn(
                  'mt-2 max-w-2xl text-body text-pretty',
                  dark ? 'text-on-brand/80' : 'text-muted',
                )}
              >
                {lead}
              </p>
            ) : null}
          </div>
          {meta ? <div className="min-w-0 shrink-0">{meta}</div> : null}
        </div>
        {children ? (
          <div className={cn('min-w-0 md:mt-6', compactOnPhone ? 'mt-4' : 'mt-5')}>{children}</div>
        ) : null}
      </Container>
    </section>
  );
}

/** The page under its title: the site column with the bottom rhythm. */
export function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Container className={cn('pt-6 pb-12 md:pt-8 md:pb-16 lg:pb-20', className)}>
      {children}
    </Container>
  );
}

/** Root of an inner page: full width, so a band can span the screen. */
export function InnerPage({ children, className }: { children: ReactNode; className?: string }) {
  return <FullBleed className={className}>{children}</FullBleed>;
}
