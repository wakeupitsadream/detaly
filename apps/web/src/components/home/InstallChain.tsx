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
 * A straight 2px rail drawn once by .draw-line. The viewBox is stretched to the box; the box
 * is 2px across the line, so the stroke keeps its width without vector-effect (which would
 * break pathLength and leave the line half drawn in Chrome).
 */
function Rail({
  vertical = false,
  color,
  delay = 0,
  className,
}: {
  vertical?: boolean;
  color: string;
  delay?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      className={cn('absolute overflow-visible', className)}
      viewBox={vertical ? '0 0 2 100' : '0 0 100 2'}
      preserveAspectRatio="none"
    >
      <path
        d={vertical ? 'M1 0V100' : 'M0 1H100'}
        pathLength={1}
        stroke={color}
        strokeWidth={2}
        className="draw-line"
        style={{ ['--i' as string]: delay }}
      />
    </svg>
  );
}

/**
 * The chain "part in Orenburg -> a free lift -> the car is ready". `compact` is the vertical
 * ticket of the hero; the full one is horizontal from md (vertical on phones). The connecting
 * line draws itself once (.draw-line, 700 ms; still under reduced motion).
 */
export function InstallChain({
  data,
  compact = false,
  onDark = false,
  className,
}: {
  data: InstallChainData;
  compact?: boolean;
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
  const rail = onDark ? 'var(--color-graphite-700)' : 'var(--color-line-strong)';

  if (compact) {
    return (
      <ol className={cn('relative min-w-0', className)}>
        {/* Rail behind the markers: drawn top to bottom. */}
        <Rail
          vertical
          color={rail}
          delay={8}
          className="top-4 left-[15px] h-[calc(100%-3.5rem)] w-0.5"
        />
        {steps.map((step) => (
          <li key={step.label} className="relative flex min-w-0 gap-4 pb-5">
            <span
              className={cn(
                'relative grid size-8 shrink-0 place-items-center rounded-sm border',
                onDark
                  ? 'border-graphite-700 bg-graphite-900 text-steel-200'
                  : 'border-line-strong bg-card text-ink',
              )}
            >
              {step.icon}
            </span>
            <span className="min-w-0 pt-0.5">
              <span className={cn('block text-label', muted)}>{step.label}</span>
              <span className={cn('mt-1 block font-medium', strong)}>{step.value}</span>
            </span>
          </li>
        ))}
        <li className="relative flex min-w-0 gap-4">
          <span className="relative grid size-8 shrink-0 place-items-center rounded-sm bg-accent text-ink">
            <IconCheck size={18} strokeWidth={2.25} />
          </span>
          <span className="min-w-0 pt-0.5">
            <span className={cn('block text-label', muted)}>Машина готова</span>
            <time
              dateTime={data.slotStartIso}
              className={cn('mt-1 block font-display text-2xl leading-tight font-semibold', strong)}
            >
              {data.slotDayText} {data.carReadyText}
            </time>
          </span>
        </li>
      </ol>
    );
  }

  return (
    <ol className={cn('relative grid min-w-0 gap-0 md:grid-cols-3 md:gap-6', className)}>
      {/* Horizontal rail from md (first marker to the third: two columns and two 24px gaps),
          vertical on phones; drawn once. */}
      <Rail
        color={rail}
        className="top-[21px] left-[22px] hidden h-0.5 w-[calc(66.667%+16px)] md:block"
      />
      <Rail
        vertical
        color={rail}
        className="top-[22px] left-[21px] h-[calc(100%-4.5rem)] w-0.5 md:hidden"
      />
      {steps.map((step, index) => (
        <li key={step.label} className="relative flex min-w-0 gap-4 pb-6 md:block md:pb-0">
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
