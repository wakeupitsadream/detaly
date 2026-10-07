import { CategoryIcon, categoryOf, type PartCategory } from '@/components/icons';
import { cn } from './cn';

const SIZE = {
  sm: 'size-14 rounded-control',
  md: 'size-18 rounded-tile lg:size-20',
} as const;

/**
 * Stands in for a photo (the supplier has none): a `surface` plate with the category glyph in
 * the brand colour. 72 px (80 px from lg) in an offer card (`md`), 56 px in compact lists
 * (`sm`). The glyph fills about two thirds of the plate, like the picture of a home-page Tile,
 * so a list of offers does not read as "no photo". Category comes from the offer name unless
 * given. Decorative: the name is written next to it.
 */
export function PartTile({
  name,
  category,
  size = 'md',
  className,
}: {
  name?: string | null;
  category?: PartCategory;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const cat = category ?? categoryOf(name);
  return (
    <div
      aria-hidden
      data-category={cat}
      className={cn(
        'grid shrink-0 place-items-center bg-surface text-brand',
        SIZE[size],
        className,
      )}
    >
      {size === 'sm' ? (
        <CategoryIcon category={cat} size={40} strokeWidth={1.5} />
      ) : (
        <>
          <CategoryIcon category={cat} size={48} strokeWidth={1.5} className="lg:hidden" />
          <CategoryIcon category={cat} size={52} strokeWidth={1.5} className="hidden lg:block" />
        </>
      )}
    </div>
  );
}
