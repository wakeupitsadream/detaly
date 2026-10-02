/**
 * Shown in ROSSKO_MODE=fixtures: search answers from synthetic supplier data, and the cart and
 * checkout work on it, but such an order is never placed with the supplier.
 */
export const DEMO_ARTICLES = ['OC90', 'W9142', 'GDB1330'] as const;

export function DemoDataBanner() {
  return (
    <div
      className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn"
      role="note"
      data-testid="demo-banner"
    >
      <strong className="font-semibold">Демо-данные.</strong> Цены, наличие и сроки условные:
      оформленный заказ не будет выполнен. Попробуйте артикулы{' '}
      {DEMO_ARTICLES.map((article, index) => (
        <span key={article}>
          {index > 0 ? ', ' : ''}
          {/* Plain links: no prefetch, so they never spend the search limit. */}
          <a className="font-mono underline" href={`/search?q=${article}`}>
            {article}
          </a>
        </span>
      ))}
      .
    </div>
  );
}
