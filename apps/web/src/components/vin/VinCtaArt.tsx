import { IconSts } from '@/components/icons';
import { SAMPLE_VIN } from './VinPlate';

/**
 * The picture of a «Подобрать по VIN» card (CtaCard `art`, desktop only): the СТС icon over the
 * start of a VIN plate on a white plate, the way the partner's logo sits in PickupCard. Shows
 * what the master needs before a word is read. Decorative.
 */
export function VinCtaArt() {
  return (
    <div
      aria-hidden
      className="flex w-72 flex-col items-center gap-5 rounded-tile bg-bg px-8 pt-8 pb-7 text-brand"
    >
      <IconSts size={96} />
      <div className="flex w-full items-center justify-center gap-px overflow-hidden rounded-control border border-line-strong bg-line-strong">
        {SAMPLE_VIN.slice(0, 7)
          .split('')
          .map((char, index) => (
            <span
              key={index}
              className="grid h-11 flex-1 place-items-center bg-bg text-lg font-bold text-ink tabular-nums first:bg-brand-soft first:text-brand"
            >
              {char}
            </span>
          ))}
        <span className="grid h-11 flex-1 place-items-center bg-bg text-lg font-bold text-muted">
          …
        </span>
      </div>
    </div>
  );
}
