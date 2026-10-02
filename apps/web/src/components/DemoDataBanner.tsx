import { Badge } from './ui/Badge';

/**
 * Shown in ROSSKO_MODE=fixtures: search answers from synthetic supplier data, and the cart and
 * checkout work on it, but such an order is never placed with the supplier.
 */
export const DEMO_ARTICLES = ['OC90', 'W9142', 'GDB1330'] as const;

export function DemoDataBanner() {
  return (
    <div
      className="draft-note flex min-w-0 flex-col gap-2 text-sm sm:flex-row sm:items-start sm:gap-3"
      role="note"
      data-testid="demo-banner"
    >
      <Badge tone="demo" className="shrink-0 self-start font-semibold">
        Демо-данные
      </Badge>
      <p className="min-w-0">
        Цены, наличие и сроки условные: оформленный заказ не будет выполнен. Попробуйте артикулы{' '}
        {DEMO_ARTICLES.map((article, index) => (
          <span key={article}>
            {index > 0 ? ', ' : ''}
            {/* Plain links: no prefetch, so they never spend the search limit. */}
            <a
              className="font-mono font-semibold underline underline-offset-2 hover:text-accent-ink"
              href={`/search?q=${article}`}
            >
              {article}
            </a>
          </span>
        ))}
        .
      </p>
    </div>
  );
}
