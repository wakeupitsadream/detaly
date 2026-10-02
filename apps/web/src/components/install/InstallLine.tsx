import { IconLift } from '@/components/icons';
import { cn } from '@/components/ui/cn';
import type { InstallPlanView } from '@/server/install/types';

/** No free slot within the horizon or unparsed PICKUP_HOURS: no promise, only this. */
export const INSTALL_FALLBACK_TEXT = 'окно подберём при записи';

/**
 * "Установка: чт 8 окт с 14:00 · машина готова к 16:00" under an offer, a cart line or the order's pickup block. A
 * calculation, not a booking: the master confirms the slot.
 */
export function InstallLine({
  plan,
  onDark = false,
  className,
}: {
  plan: InstallPlanView | null;
  onDark?: boolean;
  className?: string;
}) {
  return (
    <p
      className={cn(
        'flex min-w-0 items-start gap-1.5 text-sm',
        onDark ? 'text-steel-400' : 'text-muted',
        className,
      )}
      data-testid="install-line"
    >
      <IconLift size={16} className={cn('mt-0.5 shrink-0', onDark ? 'text-paper' : 'text-ink')} />
      <span className="min-w-0">
        Установка:{' '}
        {plan ? (
          <>
            <time
              dateTime={plan.slotStartIso}
              className={cn('font-medium', onDark ? 'text-paper' : 'text-ink')}
            >
              {plan.slotText}
            </time>
            {/* The dot stays with the slot when the line wraps. */}
            {'\u00a0· '}
            <span className="whitespace-nowrap">
              машина готова{' '}
              <span className={cn('font-semibold', onDark ? 'text-paper' : 'text-ink')}>
                {plan.carReadyText}
              </span>
            </span>
          </>
        ) : (
          INSTALL_FALLBACK_TEXT
        )}
      </span>
    </p>
  );
}
