import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export function chipClass(active: boolean, className?: string): string {
  return cn(
    'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-sm border px-3 text-sm whitespace-nowrap',
    'transition-colors duration-150',
    active ? 'border-ink bg-ink text-paper' : 'border-line bg-card text-ink hover:border-ink',
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
