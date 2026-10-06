import { DEMO_ARTICLES, DEMO_EXAMPLES } from '@/lib/demo-articles';
import { IconInfo } from './icons';
import { cn } from './ui/cn';

export { DEMO_ARTICLES, DEMO_EXAMPLES };

/**
 * The demo articles as round chips with what the part is: «Масляный фильтр OC 90». Plain
 * anchors, no prefetch, so they never spend the search limit. `onDark` for the brand header.
 */
export function DemoExamples({
  onDark = false,
  className,
}: {
  onDark?: boolean;
  className?: string;
}) {
  return (
    <ul className={cn('flex min-w-0 flex-wrap gap-2', className)} aria-label="Примеры артикулов">
      {DEMO_EXAMPLES.map((example) => (
        <li key={example.q} className="min-w-0">
          <a
            href={`/search?q=${example.q}`}
            className={cn(
              'inline-flex min-h-11 max-w-full items-center gap-2 rounded-full px-4 text-small transition-colors duration-150',
              onDark
                ? 'bg-on-brand/15 text-on-brand hover:bg-on-brand/25'
                : 'bg-surface text-ink hover:bg-surface-2',
            )}
          >
            <span className="truncate max-sm:hidden">{example.what}</span>
            <span className="truncate sm:hidden">{example.short}</span>
            <span className="font-bold whitespace-nowrap tabular-nums">{example.article}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

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
