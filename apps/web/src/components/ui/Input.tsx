import type { InputHTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Text field: 48px (56px `lg`, the search), card background, 1.5px `line-strong` border; ink
 * border and a soft orange ring on focus, `danger` border when aria-invalid. `mono` for article
 * numbers (placeholder too).
 */
export function inputClass({
  size = 'md',
  mono = false,
  className,
}: { size?: 'md' | 'lg'; mono?: boolean; className?: string } = {}): string {
  return cn(
    'block w-full min-w-0 rounded border-[1.5px] border-line-strong bg-card px-4 text-ink',
    'transition-[border-color,box-shadow] duration-150 placeholder:text-faint hover:border-muted',
    'focus:border-ink focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_35%,transparent)] focus-visible:outline-none',
    'aria-invalid:border-danger disabled:bg-paper-2 disabled:text-faint',
    size === 'lg' ? 'h-14 text-lg' : 'h-12 text-base',
    mono && 'font-mono tracking-wide',
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
