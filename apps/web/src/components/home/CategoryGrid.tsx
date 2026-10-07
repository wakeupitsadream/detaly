import { cn } from '@/components/ui/cn';
import { SectionHeading } from '@/components/ui/Section';
import { Tile } from '@/components/ui/Tile';
import { PART_CATEGORIES, partCategoryHref } from '@/lib/part-categories';

/**
 * «Популярные категории»: twelve grey tiles, 3 / 4 / 6 columns. There is no catalogue by
 * category, so each tile opens the VIN request with «Что нужно» filled in.
 */
export function CategoryGrid({ className }: { className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <SectionHeading id="categories-title" center>
        Популярные категории
      </SectionHeading>
      {/* Like the makes: the tiles lead to the request to the master, not to a catalogue. */}
      <p className="mt-2 text-center text-small text-muted">Подберём по VIN — бесплатно</p>
      <ul
        className="mt-5 grid min-w-0 grid-cols-3 gap-2 md:mt-8 md:grid-cols-4 md:gap-3 lg:grid-cols-6 lg:gap-4"
        data-testid="home-categories"
      >
        {PART_CATEGORIES.map((category) => (
          <li key={category.key} className="flex min-w-0">
            <Tile
              href={partCategoryHref(category)}
              prefetch={false}
              title={category.title}
              icon={category.icon}
              image={category.image}
              testId={`home-category-${category.key}`}
              className="w-full"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
