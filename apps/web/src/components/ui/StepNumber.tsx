/**
 * A step number of a «how it works» row (/vin, /returns): a neutral 32 px circle (white on the
 * grey step card), ink 700, beside the step title — the same neutral numbering as the steps of
 * /checkout, red stays for what is current. Decorative: the list is an <ol>.
 */
export function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="grid size-8 shrink-0 place-items-center rounded-full bg-bg text-base font-bold text-ink tabular-nums"
    >
      {n}
    </span>
  );
}
