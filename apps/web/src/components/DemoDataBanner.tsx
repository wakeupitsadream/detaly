import { DEMO_ARTICLES, DEMO_EXAMPLES } from '@/lib/demo-articles';
import { IconInfo } from './icons';
import { cn } from './ui/cn';

export { DEMO_ARTICLES, DEMO_EXAMPLES };

/**
 * The demo note of the search (ROSSKO_MODE=fixtures; docs/design-v2.md, «Поиск»): one thin
 * `wait-soft` plate naming the articles that answer, as plain links, with the same words on
 * every screen. `stacked` (the centred «nothing found»): the label on its own line over the
 * links, so no article is left alone on a second line. The strip above the header (DemoStrip)
 * says the rest on every page.
 */
export function DemoDataBanner({
  stacked = false,
  className,
}: {
  stacked?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 rounded-control bg-wait-soft px-3 py-1 text-small text-ink sm:px-4',
        stacked ? 'flex-col items-center text-center' : 'flex-wrap items-center gap-x-3 sm:w-fit',
        className,
      )}
      role="note"
      data-testid="demo-banner"
    >
      <span
        className={cn(
          'inline-flex items-center gap-2 font-semibold',
          stacked ? 'pt-2' : 'min-h-11',
        )}
      >
        <IconInfo size={20} className="shrink-0 text-wait" />В демо работают:
      </span>
      <span
        className={cn('flex min-w-0 flex-wrap items-center gap-x-3', stacked && 'justify-center')}
      >
        {DEMO_EXAMPLES.map((example) => (
          <a
            key={example.q}
            href={`/search?q=${example.q}`}
            className="inline-flex min-h-11 items-center font-bold whitespace-nowrap tabular-nums underline decoration-1 underline-offset-4 hover:decoration-2"
          >
            {example.article}
          </a>
        ))}
      </span>
    </div>
  );
}
