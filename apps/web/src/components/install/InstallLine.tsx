import { IconWrench } from '@/components/icons';
import { cn } from '@/components/ui/cn';
import type { InstallPlanView } from '@/server/install/types';

/** No free slot within the horizon or unparsed PICKUP_HOURS: no promise, only this. */
export const INSTALL_FALLBACK_TEXT = 'окно подберём при записи';

/** 'чт 8 окт с 14:00' -> 'чт 8 окт'; 'завтра с 10:00' -> 'завтра'. */
export function installDayText(slotText: string): string {
  return slotText.replace(/\s+с\s+\d{1,2}:\d{2}$/u, '');
}

/**
 * The «when is the car ready» feature as one line (docs/design-v2.md): a spanner and «Машина
 * готова завтра к 16:00» under an offer, a cart line or the order's pickup block. A
 * calculation, not a booking: the master confirms the slot (the slot start is in the title).
 */
export function InstallLine({
  plan,
  onDark = false,
  size = 'sm',
  className,
}: {
  plan: InstallPlanView | null;
  onDark?: boolean;
  /** sm 15 px (cards), md 17 px (the order page). */
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <p
      className={cn(
        'flex min-w-0 items-start gap-2',
        size === 'md' ? 'text-body' : 'text-small font-normal',
        onDark ? 'text-on-brand' : 'text-ink',
        className,
      )}
      data-testid="install-line"
      title={plan ? `Установка: ${plan.slotText}` : undefined}
    >
      <IconWrench
        size={size === 'md' ? 22 : 20}
        className={cn('shrink-0', onDark ? 'text-on-brand' : 'text-brand')}
      />
      <span className="min-w-0">
        {plan ? (
          <>
            Машина готова{' '}
            <span className="font-bold whitespace-nowrap">
              <time dateTime={plan.slotStartIso}>{installDayText(plan.slotText)}</time>{' '}
              {plan.carReadyText}
            </span>
          </>
        ) : (
          <>
            Установка: <span className="text-muted">{INSTALL_FALLBACK_TEXT}</span>
          </>
        )}
      </span>
    </p>
  );
}
