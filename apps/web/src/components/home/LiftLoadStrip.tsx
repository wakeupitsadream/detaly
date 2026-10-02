import { cn } from '@/components/ui/cn';

export interface LiftHour {
  hour: number;
  booked: number;
  capacity: number;
  inSlot: boolean;
}

function hh(hour: number): string {
  return String(hour).padStart(2, '0');
}

/**
 * The slot day as a lift board: one column per working hour, one cell per lift. Taken lifts
 * are graphite, free ones are outlined, the chosen window is signal orange. A text summary is
 * given to screen readers instead of the cells.
 */
export function LiftLoadStrip({
  hours,
  dayText,
  className,
}: {
  hours: readonly LiftHour[];
  dayText: string;
  className?: string;
}) {
  if (hours.length === 0) return null;
  const capacity = Math.max(...hours.map((h) => h.capacity));
  const slot = hours.filter((h) => h.inSlot);
  const summary =
    slot.length > 0
      ? `Загрузка подъёмников, ${dayText}: окно с ${hh(slot[0]!.hour)}:00 до ${hh(slot[slot.length - 1]!.hour + 1)}:00`
      : `Загрузка подъёмников, ${dayText}`;
  return (
    <figure className={cn('min-w-0', className)}>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-label text-muted">Подъёмники · {dayText}</span>
        <span className="flex items-center gap-3 text-xs text-muted" aria-hidden>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-[1px] bg-graphite-800" />
            занято
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-[1px] border border-line-strong" />
            свободно
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-[1px] bg-accent" />
            ваше окно
          </span>
        </span>
      </figcaption>
      <p className="sr-only">{summary}</p>
      <div
        aria-hidden
        className="mt-3 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${hours.length}, minmax(0, 1fr))` }}
      >
        {hours.map((h) => {
          // Our job takes one of the free lifts of the slot hours.
          const ours = h.inSlot ? 1 : 0;
          return (
            <div key={h.hour} className="flex min-w-0 flex-col gap-1">
              {Array.from({ length: capacity }, (_, lift) => {
                const taken = lift < h.booked;
                const isOurs = !taken && h.inSlot && lift < h.booked + ours;
                return (
                  <span
                    key={lift}
                    className={cn(
                      'h-4 rounded-[1px] md:h-5',
                      taken && 'bg-graphite-800',
                      isOurs && 'bg-accent',
                      !taken && !isOurs && 'border border-line-strong bg-card',
                    )}
                  />
                );
              })}
              <span
                className={cn(
                  'mt-1 text-center font-mono text-[0.6875rem] leading-none tabular-nums',
                  h.inSlot ? 'font-semibold text-ink' : 'text-faint',
                )}
              >
                {hh(h.hour)}
              </span>
            </div>
          );
        })}
      </div>
    </figure>
  );
}
