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

/**
 * The section marker of a block: a thick rounded brand bar, 96 x 6 px, inside the padding right
 * over the title (glued to the top edge it looked like a label coming off).
 */
export function MarkerBar({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block h-1.5 w-24 rounded-full bg-brand', className)} />;
}

/**
 * A light block (docs/design-v2.md, InfoCard): `bg-surface rounded-panel`, the brand marker
 * bar over the title, an optional icon and title, then one or two sentences or whatever the
 * page puts in.
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
      className={cn('min-w-0 rounded-panel bg-surface p-6 text-ink md:p-8', className)}
      {...rest}
    >
      {marker ? <MarkerBar className="mb-4 md:mb-5" /> : null}
      {title ? (
        <div className="flex min-w-0 items-center gap-3">
          {icon ? <span className="shrink-0 text-brand">{icon}</span> : null}
          <Title id={titleId} className="min-w-0 text-h2">
            {title}
          </Title>
        </div>
      ) : null}
      {children ? <div className={cn('min-w-0', Boolean(title) && 'mt-4')}>{children}</div> : null}
    </Tag>
  );
}
