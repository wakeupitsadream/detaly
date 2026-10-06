import { weekdayShort, type IsoDate } from '@detaly/domain';
import { IconWrench } from '@/components/icons';
import { cn } from '@/components/ui/cn';
import type { InstallPlanView } from '@/server/install/types';

/** No free slot within the horizon or unparsed PICKUP_HOURS: no promise, only this. */
export const INSTALL_FALLBACK_TEXT = 'время подберём при записи';

const MONTHS_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
] as const;

/**
 * '2026-10-08T14:00:00+05:00' -> 'чт 8 окт': the slot's own date, written like the arrival
 * date next to it. Never «завтра»: a relative day under an absolute arrival date read as if the
 * car were ready before the part came.
 */
export function installDateText(slotStartIso: string): string {
  const date = slotStartIso.slice(0, 10) as IsoDate;
  const [, month = 1, day = 1] = date.split('-').map(Number);
  return `${weekdayShort(date)} ${day} ${MONTHS_SHORT[month - 1] ?? ''}`;
}

/**
 * The «when is the car ready» feature as one line (docs/design-v2.md): a spanner and «С
 * установкой — машина готова чт 8 окт к 16:00» under an offer, a cart line or the order's
 * booking card. «С установкой» says whose car: the one who only buys a filter is not promised
 * anything. A calculation, not a booking: the master confirms the slot (its start is in the
 * title).
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
            С установкой — машина готова{' '}
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
