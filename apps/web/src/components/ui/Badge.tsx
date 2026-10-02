import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export type BadgeTone = 'ok' | 'info' | 'wait' | 'danger' | 'neutral' | 'demo';

const TONE: Record<BadgeTone, string> = {
  ok: 'bg-ok-soft text-ok',
  info: 'bg-info-soft text-info',
  wait: 'bg-wait-soft text-wait',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-paper-2 text-muted',
  // Signal yellow is never a state: it only marks demo data, always with ink.
  demo: 'bg-signal text-ink',
};

/** State badge: 24px, square-ish, a 6px dot on the left. */
export function Badge({
  tone = 'neutral',
  className,
  children,
  ...rest
}: { tone?: BadgeTone } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs leading-tight font-medium',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}
