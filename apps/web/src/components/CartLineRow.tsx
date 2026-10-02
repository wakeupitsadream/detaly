import type { CartLineView } from '@/server/cart/summary';
import { StockBadge } from './StockBadge';

/**
 * One cart line: brand, article, name, stock badge, date, price, a quantity form and
 * "Удалить". Both forms are plain POSTs to /api/cart/items/<id> with `_method` (no JS needed).
 */
export function CartLineRow({ line }: { line: CartLineView }) {
  const action = `/api/cart/items/${line.id}`;
  const title = `${line.brand} ${line.article}`;
  return (
    <li
      className="grid min-w-0 grid-cols-1 gap-3 rounded-card border border-line bg-card p-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_auto] md:items-center md:gap-4"
      data-testid="cart-line"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-wide text-muted uppercase wrap-anywhere">
          {line.brand}
        </div>
        <div className="font-mono text-lg font-semibold wrap-anywhere">{line.article}</div>
        <div className="mt-1 text-base wrap-anywhere">{line.name}</div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <StockBadge isLocal={line.isLocal} />
        {line.promiseText ? (
          <span className="text-sm text-muted" data-testid="cart-line-promise">
            Получение <span className="font-medium text-ink">{line.promiseText}</span>
          </span>
        ) : null}
        <span className="text-sm text-muted">
          <span className="whitespace-nowrap">{line.priceText}</span> за шт.
          {line.multiplicity > 1 ? `, продаётся по ${line.multiplicity} шт.` : null}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3 md:flex-col md:items-end">
        <div
          className="text-xl font-bold whitespace-nowrap md:text-right"
          data-testid="cart-line-total"
        >
          {line.lineTotalText}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <form method="post" action={action} className="flex items-center gap-2">
            <input type="hidden" name="_method" value="patch" />
            <label className="sr-only" htmlFor={`qty-${line.id}`}>
              Количество: {title}
            </label>
            <input
              id={`qty-${line.id}`}
              type="number"
              name="qty"
              inputMode="numeric"
              min={line.multiplicity}
              max={line.maxQty}
              step={line.multiplicity}
              defaultValue={line.qty}
              required
              className="h-11 w-20 rounded-xl border border-line bg-card px-3 text-base"
            />
            <button
              type="submit"
              className="inline-flex h-11 items-center rounded-xl border border-line px-3 text-sm font-medium hover:border-ink"
            >
              Изменить
            </button>
          </form>
          <form method="post" action={action}>
            <input type="hidden" name="_method" value="delete" />
            <button
              type="submit"
              className="inline-flex h-11 items-center rounded-xl px-3 text-sm font-medium text-muted underline hover:text-ink"
              aria-label={`Удалить: ${title}`}
            >
              Удалить
            </button>
          </form>
        </div>
      </div>
    </li>
  );
}
