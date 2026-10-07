import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type BadgeTone = 'ok' | 'info' | 'wait' | 'danger' | 'neutral' | 'plain' | 'brand' | 'demo';

const TONE: Record<BadgeTone, string> = {
  ok: 'bg-ok-soft text-ok',
  info: 'bg-info-soft text-info',
  wait: 'bg-wait-soft text-wait',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-surface text-muted',
  // A neutral fact in full ink (offer hints «Дешевле всего»): no state colour to misread.
  plain: 'bg-surface text-ink',
  brand: 'bg-brand-soft text-brand',
  // Synthetic data: the wait tone, never a brand or state colour of its own.
  demo: 'bg-wait-soft text-wait',
};

/**
 * A round chip of state on its soft fill: 14 px (15 px `lg`) semibold. A dot on the left, or
 * an icon when given (16-18 px). The text always says the state: colour is never alone. A long
 * text that wraps (a 360 px phone) stays tidy: the radius is 20 px, not a pill turning into an
 * oval, and the dot or icon sits on the first line instead of hanging between the two.
 */
export function Badge({
  tone = 'neutral',
  icon,
  size = 'md',
  className,
  children,
  ...rest
}: { tone?: BadgeTone; icon?: ReactNode; size?: 'md' | 'lg' } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-start gap-1.5 rounded-[1.25rem] font-semibold',
        size === 'lg'
          ? 'min-h-8 px-3.5 py-1.5 text-[0.9375rem] leading-snug'
          : 'min-h-7 px-3 py-1 text-sm leading-snug',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {/* One line high (1.375em = leading-snug), so the mark centres on the first line. */}
      <span aria-hidden className="flex h-[1.375em] shrink-0 items-center">
        {icon ?? <span className="size-2 rounded-full bg-current" />}
      </span>
      <span className="min-w-0">{children}</span>
    </span>
  );
}
