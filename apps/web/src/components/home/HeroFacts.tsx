import { cn } from '@/components/ui/cn';

export interface HeroFact {
  value: string;
  label: string;
}

/**
 * Facts in figures under the hero, set like the spec table of a data plate: a big number and a
 * plain caption, separated by hairlines. Only facts backed by env and settings are passed in.
 */
export function HeroFacts({
  facts,
  className,
}: {
  facts: readonly HeroFact[];
  className?: string;
}) {
  if (facts.length === 0) return null;
  return (
    <dl
      className={cn(
        'grid min-w-0 grid-cols-2 border-t border-graphite-700 lg:grid-cols-4',
        className,
      )}
    >
      {facts.map((fact, index) => (
        <div
          key={fact.label}
          className={cn(
            'flex min-w-0 flex-col-reverse justify-end gap-1.5 border-graphite-700 py-5 pr-4 lg:py-6 lg:pr-6',
            // Hairlines between cells: a 2x2 table on phones, one row from lg.
            index % 2 === 1 && 'border-l pl-4',
            index >= 2 && 'border-t lg:border-t-0',
            index === 2 && 'lg:border-l lg:pl-6',
            index % 2 === 1 && 'lg:pl-6',
          )}
        >
          {/* Caption first for screen readers, the figure on top visually. */}
          <dt className="text-sm leading-snug text-steel-400">{fact.label}</dt>
          <dd className="font-display text-[1.375rem] leading-none font-semibold tracking-tight whitespace-nowrap text-paper tabular-nums md:text-[1.75rem]">
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
