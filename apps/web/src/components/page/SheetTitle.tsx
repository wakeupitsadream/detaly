import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

/** «01» -> «1»: the step number in its circle. */
function stepNumber(index: string): string {
  return /^\d+$/.test(index) ? String(Number(index)) : index;
}

/**
 * Heading of a card or a checkout step: an optional step number in a 32 px neutral circle (the
 * brand red stays for the current step of CheckoutSteps alone, so two red «2» never meet), the
 * title in `text-h3` and an optional `aside` on the right. `as` keeps the outline right (h2 on a
 * page, h3 inside a section).
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
  /** Less room under the title (a list with its own padding follows). */
  tight?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-3', tight ? 'mb-2' : 'mb-4', className)}>
      {index ? (
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full bg-surface text-base font-extrabold text-ink tabular-nums"
        >
          {stepNumber(index)}
        </span>
      ) : null}
      <Tag id={id} className="min-w-0 text-h3">
        {children}
      </Tag>
      {aside ? <div className="ml-auto shrink-0">{aside}</div> : null}
    </div>
  );
}
