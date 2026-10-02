import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Drawing corner marks around a key card (install widget, cart total, order header): four
 * L-shaped corners just outside the box, drawn by `.corner-marks` in globals.css. `tone="light"`
 * for graphite sections.
 */
export function CornerMarks({
  tone = 'ink',
  className,
  style,
  ...rest
}: { tone?: 'ink' | 'light' | 'accent' } & HTMLAttributes<HTMLDivElement>) {
  const color =
    tone === 'light'
      ? 'var(--color-steel-400)'
      : tone === 'accent'
        ? 'var(--color-accent)'
        : undefined;
  return (
    <div
      className={cn('corner-marks', className)}
      style={color ? { ...style, ['--corner-color' as string]: color } : style}
      {...rest}
    />
  );
}
