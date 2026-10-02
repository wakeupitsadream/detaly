import { IconNut } from '@/components/icons';

/** The mark: a signal-orange plate with a hex nut, no letters of the brand (brand is env-only). */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-sm bg-accent text-ink"
      style={{ width: size, height: size }}
    >
      <IconNut size={Math.round(size * 0.68)} strokeWidth={2} />
    </span>
  );
}
