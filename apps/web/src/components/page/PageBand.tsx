import type { CSSProperties, ReactNode } from 'react';
import { Container } from '@/components/ui/Container';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { FullBleed } from '@/components/ui/Section';
import { cn } from '@/components/ui/cn';

/**
 * A drafting rule with ticks every 8 px and a longer one every 64 px, the zero marked in signal
 * orange: the bottom edge of a page band, like the scale on a drawing.
 */
export function Ruler({ onDark = false, className }: { onDark?: boolean; className?: string }) {
  const line = onDark ? 'var(--color-graphite-700)' : 'var(--color-ink)';
  const tick = onDark ? 'rgb(255 255 255 / 0.09)' : 'var(--color-line-strong)';
  const major = onDark ? 'var(--color-steel-400)' : 'var(--color-ink)';
  const style: CSSProperties = {
    backgroundImage: [
      'linear-gradient(var(--color-accent), var(--color-accent))',
      `linear-gradient(${line}, ${line})`,
      `repeating-linear-gradient(90deg, ${major} 0 1px, transparent 1px 64px)`,
      `repeating-linear-gradient(90deg, ${tick} 0 1px, transparent 1px 8px)`,
    ].join(','),
    backgroundSize: '3rem 3px, 100% 1px, 100% 10px, 100% 5px',
    backgroundPosition: 'left bottom',
    backgroundRepeat: 'no-repeat',
  };
  return <div aria-hidden className={cn('h-2.5 w-full', className)} style={style} />;
}

/**
 * Title plate of an inner page: graphite with the drafting grid, the eyebrow, the H1, a lead
 * and whatever the page puts under it (the search form, the order stepper), closed by a ruler.
 * The page under it is laid out by PageBody on paper.
 */
export function PageBand({
  eyebrow,
  title,
  lead,
  meta,
  titleTestId,
  children,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  /** Right column from md: checkout steps, the edition of a document. */
  meta?: ReactNode;
  titleTestId?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'grain-dark bg-graphite-900 bg-blueprint text-steel-200',
        'print:bg-none print:text-ink',
        className,
      )}
    >
      <Container className="pt-7 pb-7 md:pt-12 md:pb-10">
        <div className="flex min-w-0 flex-col gap-x-10 gap-y-5 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0 md:max-w-3xl">
            {eyebrow ? (
              <Eyebrow onDark className="mb-3 md:mb-4">
                {eyebrow}
              </Eyebrow>
            ) : null}
            <h1
              className="text-h1 text-balance text-paper print:text-ink"
              data-testid={titleTestId}
            >
              {title}
            </h1>
            {lead ? (
              <p className="mt-3 max-w-2xl text-pretty text-steel-400 md:mt-4 md:text-lg">{lead}</p>
            ) : null}
          </div>
          {meta ? <div className="min-w-0 shrink-0">{meta}</div> : null}
        </div>
        {children ? <div className="mt-6 min-w-0 md:mt-8">{children}</div> : null}
      </Container>
      <Ruler onDark className="print:hidden" />
    </section>
  );
}

/** Paper part of an inner page under its band: the site column with the section rhythm. */
export function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Container className={cn('pt-8 pb-14 md:pt-12 md:pb-20 lg:pb-24', className)}>
      {children}
    </Container>
  );
}

/** Root of an inner page: full width, so the band can span the screen. */
export function InnerPage({ children, className }: { children: ReactNode; className?: string }) {
  return <FullBleed className={className}>{children}</FullBleed>;
}
