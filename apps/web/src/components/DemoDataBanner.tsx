import { DEMO_ARTICLES, DEMO_EXAMPLES } from '@/lib/demo-articles';
import { IconInfo } from './icons';
import { cn } from './ui/cn';

export { DEMO_ARTICLES, DEMO_EXAMPLES };

/**
 * The demo note of the search (ROSSKO_MODE=fixtures; docs/design-v2.md, «Поиск»): one thin
 * `wait-soft` line naming the articles that answer, as plain links. The strip above the header
 * (DemoStrip) says the rest on every page.
 */
export function DemoDataBanner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-2.5 rounded-control sm:w-fit bg-wait-soft px-3 py-0.5 text-caption text-ink sm:gap-x-3 sm:px-4 sm:text-small',
        className,
      )}
      role="note"
      data-testid="demo-banner"
    >
      <span className="inline-flex min-h-11 items-center gap-2 font-semibold">
        <IconInfo size={20} className="shrink-0 text-wait max-sm:hidden" />
        <span className="max-sm:sr-only">В демо работают:</span>
        <span aria-hidden className="sm:hidden">
          Попробуйте:
        </span>
      </span>
      {DEMO_EXAMPLES.map((example) => (
        <a
          key={example.q}
          href={`/search?q=${example.q}`}
          className="inline-flex min-h-11 items-center font-bold whitespace-nowrap tabular-nums underline decoration-1 underline-offset-4 hover:decoration-2"
        >
          {example.article}
        </a>
      ))}
    </div>
  );
}
