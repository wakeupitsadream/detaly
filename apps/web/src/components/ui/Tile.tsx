import Link from 'next/link';
import type { ReactNode } from 'react';
import { CategoryIcon, type PartCategory } from '@/components/icons';
import { cn } from './cn';

export interface TileImage {
  src: string;
  alt: string;
}

/**
 * A link tile (docs/design-v2.md, Tile): `bg-surface rounded-tile`, a 4:3 picture area, the
 * caption 16 px 600 centred in at most two lines. The picture is a photo when `image` is set
 * (WebP from public/images/categories/), otherwise the category glyph or the given icon in the
 * brand colour on the same plate, so photos can come later without touching the layout.
 */
export function Tile({
  href,
  title,
  image,
  icon,
  prefetch,
  className,
  testId,
}: {
  href: string;
  title: ReactNode;
  image?: TileImage;
  /** A PartCategory glyph or any icon element (drawn 72 / 88 px). */
  icon?: PartCategory | ReactNode;
  prefetch?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      data-testid={testId}
      className={cn(
        'group flex min-w-0 flex-col items-center gap-2 rounded-tile bg-surface px-2 pt-3 pb-4 text-center text-ink',
        'transition-[background-color,transform] duration-150 hover:-translate-y-0.5 hover:bg-surface-2',
        className,
      )}
    >
      <span className="grid aspect-[4/3] w-full place-items-center text-brand">
        {image ? (
          // A plain img: the photos are already WebP of the right size (no optimizer needed).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.src}
            alt={image.alt}
            width={256}
            height={256}
            loading="lazy"
            decoding="async"
            className="size-full object-contain"
          />
        ) : typeof icon === 'string' ? (
          <TileGlyph category={icon as PartCategory} />
        ) : (
          icon
        )}
      </span>
      <span className="line-clamp-2 min-w-0 text-base leading-5 font-semibold text-balance">
        {title}
      </span>
    </Link>
  );
}

/**
 * The category glyph at tile size: 72 px on phones, 88 px from lg, stroke 1.5, so the picture
 * fills most of the tile as the photos will.
 */
export function TileGlyph({ category }: { category: PartCategory }) {
  return (
    <>
      <CategoryIcon category={category} size={72} className="lg:hidden" />
      <CategoryIcon category={category} size={88} className="hidden lg:block" />
    </>
  );
}
