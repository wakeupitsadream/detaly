import Link from 'next/link';
import { IconChevronDown } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { SectionHeading } from '@/components/ui/Section';
import { CAR_BRANDS, FEATURED_BRANDS_COUNT, brandLogoSrc, type CarBrand } from '@/lib/brands';
import { vinRequestHref } from '@/lib/vin-link';

/** Makes shown on phones before «Все марки» (three rows of four). */
export const PHONE_BRANDS_COUNT = 12;

/**
 * Shorter names for the narrow phone tile (~72 px inside at 360-375 px); the full name shows
 * from md and goes to the request. Every other make fits at 14 px in one line: no hyphen inside
 * a name, which looked cheap («Volks-wagen»).
 */
const PHONE_NAME: Record<string, string> = { 'mercedes-benz': 'Mercedes', volkswagen: 'VW' };

/** The caption of a make on a phone tile. */
export function phoneBrandName(brand: Pick<CarBrand, 'slug' | 'name'>): string {
  return PHONE_NAME[brand.slug] ?? brand.name;
}

const GRID =
  'grid min-w-0 grid-cols-4 gap-2 max-[374px]:gap-1.5 md:grid-cols-6 md:gap-3 lg:grid-cols-8';

/**
 * One make (docs/design-v2.md, BrandTile): a white card with a `line` border, the logo in a
 * 60×36 / 96×48 box (scaled by `brand.scale`, so wide ovals do not outweigh compact emblems and
 * keep clear of the rounded frame), the name under it. Leads to the VIN request with the make filled in.
 */
export function BrandTile({
  brand,
  lazy = false,
  className,
}: {
  brand: CarBrand;
  lazy?: boolean;
  className?: string;
}) {
  const phoneName = phoneBrandName(brand);
  return (
    <li className={cn('min-w-0', className)}>
      <Link
        href={vinRequestHref({ car: brand.name })}
        prefetch={false}
        data-testid={`home-brand-${brand.slug}`}
        className={cn(
          'flex h-full min-h-24 min-w-0 flex-col items-center justify-center gap-2 rounded-tile border border-line bg-bg px-0.5 pt-3 pb-2.5 text-center text-ink max-[374px]:px-0 md:px-1',
          'transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-line-strong',
          'md:min-h-28 md:gap-2.5 md:pt-4 md:pb-3',
        )}
      >
        {/* A plain img: the logos are small trimmed WebP files (docs/assets.md). The 60 px box
            leaves ~10 px of air to the rounded frame on a 80 px phone tile, while the tile itself
            keeps a thin side padding so «Mitsubishi» still fits in one line under it. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={brandLogoSrc(brand)}
          alt=""
          width={brand.width}
          height={brand.height}
          loading={lazy ? 'lazy' : undefined}
          decoding="async"
          style={brand.scale ? { transform: `scale(${brand.scale})` } : undefined}
          className="h-9 w-[3.75rem] max-w-full object-contain md:h-12 md:w-24"
        />
        {/* 14 px on phones, 15 px from md; never broken inside a word («Mitsubish / i»): a
            little tighter tracking under 375 px keeps «Mitsubishi» and «Chevrolet» whole. */}
        <span className="max-w-full text-[0.875rem] leading-[1.125rem] font-semibold tracking-[-0.01em] break-normal hyphens-none max-[374px]:tracking-[-0.02em] md:text-[0.9375rem]">
          {phoneName !== brand.name ? (
            <>
              <span className="md:hidden">{phoneName}</span>
              <span className="hidden md:inline">{brand.name}</span>
            </>
          ) : (
            brand.name
          )}
        </span>
      </Link>
    </li>
  );
}

/**
 * «Выберите марку»: the most common makes as logo tiles (12 on phones, FEATURED_BRANDS_COUNT
 * from md), «Все марки» opens the rest without JS. The makes between the two counts sit in
 * both lists: shown in the grid from md, inside «Все марки» only on phones.
 */
export function BrandGrid({ className }: { className?: string }) {
  const featured = CAR_BRANDS.slice(0, FEATURED_BRANDS_COUNT);
  const rest = CAR_BRANDS.slice(PHONE_BRANDS_COUNT);
  return (
    <div className={cn('min-w-0', className)}>
      <SectionHeading id="brands-title">Выберите марку</SectionHeading>
      {/* The tiles lead to the request to the master, not to a catalogue: said up front. */}
      <p className="mt-2 text-small text-muted">Подберём по VIN — бесплатно</p>
      <ul className={cn(GRID, 'mt-5 md:mt-6')} data-testid="home-brands">
        {featured.map((brand, index) => (
          <BrandTile
            key={brand.slug}
            brand={brand}
            className={index >= PHONE_BRANDS_COUNT ? 'max-md:hidden' : undefined}
          />
        ))}
      </ul>
      {rest.length > 0 ? (
        <details className="details-plain group mt-4 min-w-0 md:mt-5">
          <summary
            className={cn(
              buttonClass({ variant: 'secondary' }),
              'w-full md:w-auto md:min-w-56 [&::-webkit-details-marker]:hidden',
            )}
            data-testid="home-brands-all"
          >
            <span className="group-open:hidden">Все марки</span>
            <span className="hidden group-open:inline">Свернуть</span>
            <IconChevronDown
              size={20}
              className="transition-transform duration-150 group-open:rotate-180"
            />
          </summary>
          <ul className={cn(GRID, 'mt-4 md:mt-5')}>
            {rest.map((brand, index) => (
              <BrandTile
                key={brand.slug}
                brand={brand}
                lazy
                className={
                  index + PHONE_BRANDS_COUNT < FEATURED_BRANDS_COUNT ? 'md:hidden' : undefined
                }
              />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
