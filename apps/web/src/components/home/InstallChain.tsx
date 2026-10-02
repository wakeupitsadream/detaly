import { IconCheck, IconLift, IconNut } from '@/components/icons';
import { cn } from '@/components/ui/cn';

export interface InstallChainData {
  /** 'к чт 8 октября' */
  partText: string;
  /** 'чт 8 окт с 12:00' */
  slotText: string;
  /** 'чт 8 окт' | 'сегодня' | 'завтра' */
  slotDayText: string;
  /** 'к 14:00' */
  carReadyText: string;
  slotStartIso: string;
}

/**
 * A 2px connector from one marker to the next, a plain box drawn once by .draw-line (scaleX
 * from its left edge; .draw-line-y top-down on phones). Being a box, its end state is always
 * the whole segment: no stroke-dash arithmetic that could stop short of the next marker.
 */
function Connector({ onDark, delay }: { onDark: boolean; delay: number }) {
  const color = onDark ? 'bg-graphite-700' : 'bg-line-strong';
  return (
    <>
      {/* Desktop: from the marker's right edge (44px + 8px) across the column and the 24px gap
          to 8px before the next marker. */}
      <span
        aria-hidden
        className={cn('draw-line absolute top-[21px] left-[52px] hidden h-0.5 md:block', color)}
        style={{ width: 'calc(100% - 36px)', ['--i' as string]: delay }}
      />
      {/* Phones: down from under the marker to the next row. */}
      <span
        aria-hidden
        className={cn(
          'draw-line-y absolute top-[52px] bottom-0 left-[21px] w-0.5 md:hidden',
          color,
        )}
        style={{ ['--i' as string]: delay }}
      />
    </>
  );
}

/**
 * The chain "part in Orenburg -> a free lift -> the car is ready": horizontal from md,
 * vertical on phones. The connectors draw themselves once (700 ms; whole under reduced
 * motion).
 */
export function InstallChain({
  data,
  onDark = false,
  className,
}: {
  data: InstallChainData;
  onDark?: boolean;
  className?: string;
}) {
  const steps = [
    {
      icon: <IconNut size={18} />,
      label: 'Деталь в Оренбурге',
      value: data.partText,
    },
    {
      icon: <IconLift size={18} />,
      label: 'Свободен подъёмник',
      value: data.slotText,
    },
  ];
  const muted = onDark ? 'text-steel-400' : 'text-muted';
  const strong = onDark ? 'text-paper' : 'text-ink';

  return (
    <ol className={cn('relative grid min-w-0 gap-0 md:grid-cols-3 md:gap-6', className)}>
      {steps.map((step, index) => (
        <li key={step.label} className="relative flex min-w-0 gap-4 pb-6 md:block md:pb-0">
          <Connector onDark={onDark} delay={2 + index * 4} />
          <span
            className={cn(
              'relative grid size-11 shrink-0 place-items-center rounded-sm border-[1.5px]',
              onDark
                ? 'border-graphite-700 bg-graphite-900 text-paper'
                : 'border-ink bg-card text-ink',
            )}
          >
            {step.icon}
          </span>
          <span className="block min-w-0 pt-1 md:mt-4 md:pt-0">
            <span className={cn('block text-label', muted)}>
              {String(index + 1).padStart(2, '0')} · {step.label}
            </span>
            <span className={cn('mt-1.5 block text-lg leading-snug font-semibold', strong)}>
              {step.value}
            </span>
          </span>
        </li>
      ))}
      <li className="relative flex min-w-0 gap-4 md:block">
        <span className="relative grid size-11 shrink-0 place-items-center rounded-sm bg-accent text-ink">
          <IconCheck size={22} strokeWidth={2.25} />
        </span>
        <span className="block min-w-0 pt-1 md:mt-4 md:pt-0">
          <span className={cn('block text-label', muted)}>03 · Машина готова</span>
          <time
            dateTime={data.slotStartIso}
            className={cn(
              'mt-1.5 block font-display text-[1.75rem] leading-none font-semibold tracking-tight',
              strong,
            )}
          >
            {data.carReadyText}
          </time>
          <span className={cn('mt-1.5 block text-sm', muted)}>{data.slotDayText}</span>
        </span>
      </li>
    </ol>
  );
}
