import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

/**
 * Heading of a sheet (card) of the repair card: a mono section number like «01» in rust, the
 * title in the text face (text-h3) and a hairline under it. `as` keeps the outline right (h2 on a page,
 * h3 inside a section).
 */
export function SheetTitle({
  index,
  as: Tag = 'h2',
  id,
  aside,
  tight = false,
  className,
  children,
}: {
  index?: string;
  as?: 'h2' | 'h3';
  id?: string;
  aside?: ReactNode;
  /** Less room under the hairline (a list with its own padding follows). */
  tight?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-baseline gap-3 border-b border-line pb-3',
        tight ? 'mb-1' : 'mb-4 md:mb-5',
        className,
      )}
    >
      {index ? (
        <span
          aria-hidden
          className="shrink-0 font-mono text-xs font-semibold tracking-wider text-accent-ink tabular-nums"
        >
          {index}
        </span>
      ) : null}
      <Tag id={id} className="min-w-0 text-h3">
        {children}
      </Tag>
      {aside ? <div className="ml-auto shrink-0">{aside}</div> : null}
    </div>
  );
}
