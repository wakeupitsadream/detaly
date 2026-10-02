import { CATEGORY_LABEL, CategoryIcon, categoryOf, type PartCategory } from '@/components/icons';
import { cn } from './cn';

const SIZE = {
  sm: 'size-14',
  md: 'size-16 md:size-18',
} as const;

/**
 * Stands in for a photo (the supplier has none): a graphite plate with the tread pattern, the
 * category glyph in the middle and a mono caption in the corner. Category comes from the offer
 * name unless given.
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
        'relative grid shrink-0 place-items-center overflow-hidden rounded bg-graphite-800 bg-tread text-steel-200',
        SIZE[size],
        className,
      )}
    >
      <CategoryIcon category={cat} size={28} />
      <span className="absolute right-1 bottom-0.5 font-mono text-[9px] leading-none tracking-wider text-steel-400 uppercase">
        {CATEGORY_LABEL[cat]}
      </span>
    </div>
  );
}
