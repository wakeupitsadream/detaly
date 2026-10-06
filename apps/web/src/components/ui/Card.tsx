import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

type CardTag = 'div' | 'section' | 'article' | 'aside' | 'li';

/**
 * A white card: 1px `line` border, `rounded-tile`, no shadow. `tone="surface"` for a grey card
 * on white, `tone="dark"` for a tile on the dark panel.
 */
export function Card({
  as: Tag = 'div',
  tone = 'light',
  padded = true,
  className,
  ...rest
}: {
  as?: CardTag;
  tone?: 'light' | 'surface' | 'dark';
  padded?: boolean;
} & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn(
        'min-w-0 rounded-tile',
        tone === 'dark' && 'bg-dark-2 text-on-brand',
        tone === 'surface' && 'bg-surface text-ink',
        tone === 'light' && 'border border-line bg-bg text-ink',
        padded && 'p-4 md:p-5',
        className,
      )}
      {...rest}
    />
  );
}

/** The section marker on top of a block: a thick brand bar, 96 x 6 px. */
export function MarkerBar({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block h-1.5 w-24 bg-brand', className)} />;
}

/**
 * A light block (docs/design-v2.md, InfoCard): `bg-surface rounded-panel`, the brand marker
 * bar on its top edge over the content, an optional icon and title, then one or two sentences
 * or whatever the page puts in.
 */
export function InfoCard({
  as: Tag = 'section',
  title,
  titleAs: Title = 'h2',
  titleId,
  icon,
  marker = true,
  className,
  children,
  ...rest
}: {
  as?: CardTag;
  title?: ReactNode;
  titleAs?: 'h2' | 'h3';
  titleId?: string;
  /** 40 px brand icon left of the title. */
  icon?: ReactNode;
  marker?: boolean;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <Tag
      className={cn('relative min-w-0 rounded-panel bg-surface p-6 text-ink md:p-8', className)}
      {...rest}
    >
      {marker ? <MarkerBar className="absolute top-0 left-6 md:left-8" /> : null}
      {title ? (
        <div className={cn('flex min-w-0 items-center gap-3', marker && 'pt-2')}>
          {icon ? <span className="shrink-0 text-brand">{icon}</span> : null}
          <Title id={titleId} className="min-w-0 text-h2">
            {title}
          </Title>
        </div>
      ) : null}
      {children ? (
        <div className={cn('min-w-0', title ? 'mt-4' : marker && 'pt-2')}>{children}</div>
      ) : null}
    </Tag>
  );
}
