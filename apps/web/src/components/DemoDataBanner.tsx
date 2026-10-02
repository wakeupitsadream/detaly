import { DEMO_ARTICLES, DEMO_EXAMPLES } from '@/lib/demo-articles';
import { cn } from './ui/cn';
import { Badge } from './ui/Badge';

export { DEMO_ARTICLES, DEMO_EXAMPLES };

/**
 * The demo articles as plain links with what the part is: «Масляный фильтр · OC 90». Plain
 * anchors, no prefetch, so they never spend the search limit.
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
              'group inline-flex min-h-9 max-w-full items-center gap-2 rounded-sm border px-3 text-sm transition-colors duration-150',
              onDark
                ? 'border-graphite-700 text-steel-200 hover:border-steel-400 hover:text-paper'
                : 'border-line bg-card text-ink hover:border-ink',
            )}
          >
            <span className="truncate max-sm:hidden">{example.what}</span>
            <span className="truncate sm:hidden">{example.short}</span>
            <span aria-hidden className={onDark ? 'text-graphite-700' : 'text-line-strong'}>
              ·
            </span>
            <span className="font-mono font-semibold whitespace-nowrap">{example.article}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * The full demo note for an empty search (ROSSKO_MODE=fixtures): only these articles answer,
 * so a visitor who typed something else gets them as the way forward. The thin strip above the
 * header (DemoStrip) says the rest on every page.
 */
export function DemoDataBanner() {
  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded border border-dashed border-line-strong bg-paper p-4"
      role="note"
      data-testid="demo-banner"
    >
      <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <Badge tone="demo" className="font-semibold">
          Демо
        </Badge>
        <span className="min-w-0 text-muted">
          В демо-витрине отвечают эти артикулы — попробуйте любой:
        </span>
      </p>
      <DemoExamples />
    </div>
  );
}
