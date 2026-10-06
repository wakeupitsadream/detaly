import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * @deprecated «Техкарта» label above a heading; replaced by SectionHeading. Now a quiet 15 px
 * caption without mono, caps or marker, until the page packages drop it (docs/design-v2.md,
 * section 7).
 */
export function Eyebrow({
  onDark = false,
  marker: _marker = true,
  className,
  children,
  ...rest
}: { onDark?: boolean; marker?: boolean } & HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'min-w-0 text-small font-semibold',
        onDark ? 'text-on-brand/80' : 'text-muted',
        className,
      )}
      {...rest}
    >
      {children}
    </p>
  );
}
