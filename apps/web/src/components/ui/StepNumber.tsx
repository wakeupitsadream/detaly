import type { IconComponent } from '@/components/icons';
import { cn } from './cn';

/**
 * A step number of a «how it works» row (/vin, /returns): a neutral 28 px circle, white with a
 * `line` border, ink 700 — the same neutral numbering as the steps of /checkout, red stays for
 * what is current. Decorative: the list is an <ol>.
 */
export function StepNumber({ n, className }: { n: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full border border-line bg-bg text-[0.9375rem] font-bold text-ink tabular-nums',
        className,
      )}
    >
      {n}
    </span>
  );
}

/**
 * The picture of a step: the brand icon on a white plate (64 px, 80 px from md) with the step
 * number as a badge on its top-left corner, so the title next to it takes the whole remaining
 * width and fits one line on a 360 px phone. Decorative: the title says the step.
 */
export function StepIconTile({ n, icon: Icon }: { n: number; icon: IconComponent }) {
  return (
    <span
      aria-hidden
      className="relative grid size-16 shrink-0 place-items-center rounded-tile bg-bg text-brand md:size-20"
    >
      <Icon size={40} className="md:hidden" />
      <Icon size={48} className="hidden md:block" />
      <StepNumber n={n} className="absolute -top-2 -left-2" />
    </span>
  );
}
