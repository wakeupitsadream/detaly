import type { InputHTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Text field: 56 px (64 px `lg`, the VIN), 17 px text, `rounded-control`, `surface` at rest
 * with a `line-strong` border; white with a brand border and a soft ring on focus, `danger`
 * border when aria-invalid. `mono` is the old name for codes: tabular digits, a little tracking.
 */
export function inputClass({
  size = 'md',
  mono = false,
  className,
}: { size?: 'md' | 'lg'; mono?: boolean; className?: string } = {}): string {
  return cn(
    'block w-full min-w-0 rounded-control border-[1.5px] border-line-strong bg-surface px-4 text-ink',
    'transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-muted hover:border-muted',
    'focus:border-brand focus:bg-bg focus:shadow-[0_0_0_3px_var(--color-brand-soft)] focus-visible:outline-none',
    'aria-invalid:border-danger disabled:bg-surface-2 disabled:text-muted',
    size === 'lg' ? 'h-16 text-[1.1875rem]' : 'h-14 text-[1.0625rem]',
    mono && 'tracking-wide tabular-nums',
    className,
  );
}

export function Input({
  size,
  mono,
  className,
  ...rest
}: { size?: 'md' | 'lg'; mono?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>) {
  return <input className={inputClass({ size, mono, className })} {...rest} />;
}
