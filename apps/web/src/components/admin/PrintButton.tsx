'use client';

/** «Печать» of the counter sign (step 3): the browser's print dialog. */
export function PrintButton({
  className,
  label = 'Печать',
}: {
  className?: string;
  label?: string;
}) {
  return (
    <button type="button" onClick={() => window.print()} className={className}>
      {label}
    </button>
  );
}
