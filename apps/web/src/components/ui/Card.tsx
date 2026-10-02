import type { HTMLAttributes } from 'react';
import { cn } from './cn';

type CardTag = 'div' | 'section' | 'article' | 'aside' | 'li';

/**
 * A sheet of the repair card: 1px `line` border, no shadow. `corners` adds the drawing corner
 * marks (only on key cards). `tone="dark"` for a plate on graphite.
 */
export function Card({
  as: Tag = 'div',
  corners = false,
  tone = 'light',
  padded = true,
  className,
  ...rest
}: {
  as?: CardTag;
  corners?: boolean;
  tone?: 'light' | 'dark';
  padded?: boolean;
} & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn(
        'min-w-0 rounded border',
        tone === 'dark'
          ? 'border-graphite-700 bg-graphite-800 text-steel-200'
          : 'border-line bg-card text-ink',
        padded && 'p-4 md:p-6',
        corners && 'corner-marks',
        className,
      )}
      {...rest}
    />
  );
}
