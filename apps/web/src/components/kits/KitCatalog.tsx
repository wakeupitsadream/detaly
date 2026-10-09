/**
 * The catalogue of maintenance kits (step 5, docs/kits.md): the makes with published kits on
 * /to (the logos of the home page, docs/assets.md) and the models of a make on /to/<make> (the
 * engines and years of each). Cards are links; nothing here needs JavaScript.
 */
import { formatKitYears, KIT_DEMO_LABEL } from '@detaly/domain';
import Link from 'next/link';
import { IconChevron } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { cn } from '@/components/ui/cn';
import { brandLogoSrc, type CarBrand } from '@/lib/brands';
import { kitMakePath, kitModelPath } from '@/lib/kit-paths';
import type { KitMakeEntry, KitModelEntry } from '@/server/kits/catalog';

/** The demo's samples say so on every kit page (their title area). */
export function KitsDemoNote({ className }: { className?: string }) {
  return (
    <Notice tone="wait" role="note" className={className} data-testid="kit-demo-label">
      {KIT_DEMO_LABEL}
    </Notice>
  );
}

/** The makes with published kits as logo cards leading to /to/<make>. */
export function KitMakeGrid({ makes }: { makes: readonly KitMakeEntry[] }) {
  return (
    <ul
      className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
      data-testid="kit-makes"
    >
      {makes.map(({ brand, models }) => (
        <li key={brand.slug} className="min-w-0">
          <Link
            href={kitMakePath(brand.slug)}
            className={cn(
              'flex h-full min-h-36 min-w-0 flex-col items-center justify-center gap-3 rounded-tile border border-line bg-bg px-3 py-5 text-center text-ink',
              'transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-line-strong',
            )}
            data-testid={`kit-make-${brand.slug}`}
          >
            {/* A plain img: the logos are small trimmed WebP files (docs/assets.md). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={brandLogoSrc(brand)}
              alt=""
              width={brand.width}
              height={brand.height}
              decoding="async"
              style={brand.scale ? { transform: `scale(${brand.scale})` } : undefined}
              className="h-12 w-24 max-w-full object-contain"
            />
            <span className="min-w-0">
              <span className="block text-[1.0625rem] leading-snug font-bold">{brand.name}</span>
              <span className="mt-0.5 line-clamp-2 text-small font-normal text-muted">
                {models.join(', ')}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The models of a make: the logo, the name, the engines with their years, a link to the kits. */
export function KitModelList({
  brand,
  models,
}: {
  brand: CarBrand;
  models: readonly KitModelEntry[];
}) {
  return (
    <ul className="grid min-w-0 gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="kit-models">
      {models.map((entry) => (
        <li key={entry.modelSlug} className="min-w-0">
          <Link
            href={kitModelPath(brand.slug, entry.modelSlug)}
            className={cn(
              'flex h-full min-h-24 min-w-0 items-center gap-4 rounded-tile border border-line bg-bg p-5 text-ink',
              'transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-line-strong',
            )}
            data-testid={`kit-model-${entry.modelSlug}`}
          >
            <span
              aria-hidden
              className="grid size-14 shrink-0 place-items-center rounded-control bg-surface"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={brandLogoSrc(brand)}
                alt=""
                width={brand.width}
                height={brand.height}
                decoding="async"
                style={brand.scale ? { transform: `scale(${brand.scale})` } : undefined}
                className="h-8 w-11 object-contain"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-h3 wrap-anywhere">
                {brand.name} {entry.model}
              </span>
              <span className="mt-2 block space-y-1">
                {entry.kits.map((kit) => (
                  <span key={kit.id} className="block text-small font-normal text-muted">
                    <span className="font-semibold text-ink">{kit.engine}</span> ·{' '}
                    <span className="whitespace-nowrap">
                      {formatKitYears(kit.yearsFrom, kit.yearsTo)}
                    </span>
                  </span>
                ))}
              </span>
            </span>
            <IconChevron size={24} className="shrink-0 text-brand" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
