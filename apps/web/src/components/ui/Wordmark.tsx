import Link from 'next/link';
import { cn } from './cn';

/** The first letter of the shop's name (BRAND_NAME from env), for the mark tile. */
export function wordmarkInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? '').toUpperCase();
}

/**
 * The shop's wordmark (docs/design-v2.md, SiteHeader and Footer): a rounded tile with the first
 * letter of BRAND_NAME and the name beside it, Manrope 800 — the shop's own sign, apart from
 * the partner's logo. Colours come only from tokens: `onBrand` is a white tile with a brand
 * letter and a white name for the red plate, `onLight` a brand tile with a white letter and an
 * ink name for white surfaces (the footer).
 */
export function Wordmark({
  name,
  tone,
  size = 'md',
  className,
}: {
  name: string;
  tone: 'onBrand' | 'onLight';
  /** `lg`: the footer and the desktop plate. */
  size?: 'md' | 'lg';
  className?: string;
}) {
  const initial = wordmarkInitial(name);
  return (
    <Link
      href="/"
      className={cn(
        // -ml-2 px-2: room for the focus ring, which the plate draws inside the link.
        '-ml-2 min-h-11 min-w-0 items-center gap-2.5 px-2 leading-none font-extrabold tracking-[-0.02em]',
        size === 'lg' ? 'text-[1.625rem]' : 'text-[1.375rem] lg:text-[1.625rem]',
        tone === 'onBrand' ? 'text-on-brand' : 'text-ink',
        className,
      )}
      data-testid="brand-wordmark"
    >
      {initial ? (
        <span
          aria-hidden
          className={cn(
            'grid shrink-0 place-items-center rounded-[10px] leading-none font-extrabold tracking-normal',
            size === 'lg'
              ? 'size-10 text-[1.5rem]'
              : 'size-8 text-[1.25rem] lg:size-10 lg:text-[1.5rem]',
            tone === 'onBrand' ? 'bg-on-brand text-brand' : 'bg-brand text-on-brand',
          )}
        >
          {initial}
        </span>
      ) : null}
      {/* leading-tight: the descender of «Д» is not clipped by truncate. */}
      <span className="min-w-0 truncate leading-tight">{name}</span>
    </Link>
  );
}
