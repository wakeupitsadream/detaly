import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/** A round chip: 44 px high, 15 px semibold; the active one is filled with the brand. */
export function chipClass(active: boolean, className?: string): string {
  return cn(
    'inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-[0.9375rem] font-semibold whitespace-nowrap',
    'transition-colors duration-150',
    active ? 'bg-brand text-on-brand' : 'bg-surface text-ink hover:bg-surface-2',
    className,
  );
}

/**
 * Filter chip as a plain link (no prefetch: a search link spends the search limit). The active
 * one carries aria-current="true".
 */
export function Chip({
  href,
  active = false,
  className,
  children,
  ...rest
}: {
  href: string;
  active?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLAnchorElement>, 'className' | 'children'>) {
  return (
    <a
      href={href}
      aria-current={active ? 'true' : undefined}
      className={chipClass(active, className)}
      {...rest}
    >
      {children}
    </a>
  );
}

/** A row of chips: scrolls horizontally on phones with a fade at the right edge, wraps from md. */
export function ChipRow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('chip-row', className)} {...rest} />;
}
