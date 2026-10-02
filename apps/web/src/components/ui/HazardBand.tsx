import { cn } from './cn';

/** Hazard tape between the hero and the install widget: 10px of signal yellow and graphite. */
export function HazardBand({ className }: { className?: string }) {
  return <div aria-hidden className={cn('hazard h-2.5 w-full', className)} />;
}
