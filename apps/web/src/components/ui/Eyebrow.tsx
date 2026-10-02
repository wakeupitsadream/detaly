import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Mono uppercase label above a heading ("Оренбург · автозапчасти с установкой"), with a small
 * signal-orange square like a marking on equipment.
 */
export function Eyebrow({
  onDark = false,
  marker = true,
  className,
  children,
  ...rest
}: { onDark?: boolean; marker?: boolean } & HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'flex min-w-0 items-center gap-2 text-label',
        onDark ? 'text-steel-400' : 'text-muted',
        className,
      )}
      {...rest}
    >
      {marker ? <span aria-hidden className="size-2 shrink-0 bg-accent" /> : null}
      <span className="min-w-0">{children}</span>
    </p>
  );
}
