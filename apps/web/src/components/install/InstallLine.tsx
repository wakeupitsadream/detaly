import { formatDayMonth, weekdayShort, type IsoDate } from '@detaly/domain';
import { IconWrench } from '@/components/icons';
import { cn } from '@/components/ui/cn';
import type { InstallPlanView } from '@/server/install/types';

/** No free slot within the horizon or unparsed PICKUP_HOURS: no promise, only this. */
export const INSTALL_FALLBACK_TEXT = 'время подберём при записи';

/**
 * '2026-10-08T14:00:00+05:00' -> 'чт 8 октября': the slot's own date, written exactly like the
 * arrival date next to it («Получение к чт 8 октября»), so the two lines never look like two
 * different days. Never «завтра»: a relative day under an absolute arrival date read as if the
 * car were ready before the part came. The short «8 окт» stays only in the slot chips.
 */
export function installDateText(slotStartIso: string): string {
  const date = slotStartIso.slice(0, 10) as IsoDate;
  return `${weekdayShort(date)} ${formatDayMonth(date)}`;
}

/**
 * The «when is the car ready» feature as one line (docs/design-v2.md): a spanner and «Машина
 * готова чт 8 октября к 16:00» under an offer, a cart line or the order's booking card. The spanner
 * stands for «with installation» (said to screen readers): the one who only buys a filter is
 * not promised anything, and the short text keeps the line on one line at 375 px. A
 * calculation, not a booking: the master confirms the slot (its start is in the title).
 */
export function InstallLine({
  plan,
  onDark = false,
  size = 'sm',
  icon = true,
  className,
}: {
  plan: InstallPlanView | null;
  onDark?: boolean;
  /** The spanner on the left; off under a title that has the spanner already. */
  icon?: boolean;
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
      {icon ? (
        <IconWrench
          size={size === 'md' ? 22 : 20}
          className={cn('shrink-0', onDark ? 'text-on-brand' : 'text-brand')}
        />
      ) : null}
      <span className="min-w-0">
        {plan ? (
          <>
            {/* The spanner says «with installation» to the eye; a screen reader hears it. */}
            <span className="sr-only">С установкой — </span>
            Машина готова{' '}
            <span className="font-bold whitespace-nowrap">
              <time dateTime={plan.slotStartIso}>{installDateText(plan.slotStartIso)}</time>{' '}
              {plan.carReadyText}
            </span>
          </>
        ) : (
          <>Установка — {INSTALL_FALLBACK_TEXT}</>
        )}
      </span>
    </p>
  );
}
