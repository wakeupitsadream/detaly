import { wordmarkInitial } from '@/components/ui/Wordmark';

/**
 * The counter sign of /admin/reviews/sign (step 3, docs/reviews.md): the brand, «Оставьте отзыв —
 * наведите камеру», a large QR of APP_BASE_URL/review and the names of the map services under it
 * (plain text, no logos). On screen a framed A5 page; in print only the sign (the admin chrome
 * carries data-print-hide), on A5 or A4 (`size`).
 */
export type SignSize = 'a5' | 'a4';

export function ReviewSign({
  brandName,
  qrSrc,
  platforms,
  url,
  size,
}: {
  brandName: string;
  /** The QR as a data URI (qrSvgPrintDataUri). */
  qrSrc: string;
  /** The names of the map services under the QR. */
  platforms: readonly string[];
  /** What the QR encodes, printed small for typing by hand. */
  url: string;
  size: SignSize;
}) {
  const a4 = size === 'a4';
  return (
    <>
      {/* The paper format of the print dialog; inline styles are allowed by the CSP. */}
      <style>{`@page { size: ${a4 ? 'A4' : 'A5'} portrait; margin: ${a4 ? 16 : 10}mm; }`}</style>
      <article
        className={`mx-auto flex w-full flex-col items-center justify-center gap-4 rounded-card border border-line bg-white px-6 py-10 text-center text-ink sm:px-10 sm:py-14 print:rounded-none print:border-0 print:p-0 ${
          a4 ? 'max-w-[210mm] print:min-h-[262mm]' : 'max-w-[148mm] print:min-h-[188mm]'
        }`}
        data-testid="review-sign"
        data-size={size}
      >
        {/* The shop's mark as on the site (Wordmark): a brand tile with the first letter. */}
        <p className="flex min-w-0 items-center justify-center gap-3 text-[clamp(1.75rem,7vw,2.75rem)] leading-none font-extrabold tracking-tight print:text-[30pt]">
          <span
            aria-hidden
            className="grid size-[1.4em] shrink-0 place-items-center rounded-[0.3em] bg-brand text-on-brand [print-color-adjust:exact]"
          >
            {wordmarkInitial(brandName)}
          </span>
          <span className="min-w-0">{brandName}</span>
        </p>
        <h1 className="mt-2 text-[clamp(1.25rem,5vw,2rem)] leading-tight font-extrabold text-balance print:text-[20pt]">
          Оставьте отзыв — наведите камеру
        </h1>
        {/* eslint-disable-next-line @next/next/no-img-element -- an inline SVG data URI */}
        <img
          src={qrSrc}
          alt={`QR-код: ${url}`}
          width={400}
          height={400}
          className="mt-2 aspect-square w-[80%] max-w-[110mm] shrink-0"
          data-testid="review-sign-qr"
        />
        <p
          className="mt-2 text-[clamp(1.125rem,4.5vw,1.75rem)] font-bold print:text-[17pt]"
          data-testid="review-sign-platforms"
        >
          {platforms.join(' · ')}
        </p>
        <p className="text-sm text-muted wrap-anywhere print:text-[9pt]">{url}</p>
      </article>
    </>
  );
}
