import type { CartLineView } from '@/server/cart/summary';
import { IconClock } from './icons';
import { StockBadge } from './StockBadge';
import { buttonClass } from './ui/Button';
import { inputClass } from './ui/Input';
import { PartTile } from './ui/PartTile';
import { Price } from './ui/Price';

/**
 * One cart line: tile, brand, article, name, stock badge and date; the line total on the right
 * (desktop) or on its own line (phones); the quantity form and "Удалить" under it. Both forms
 * are plain POSTs to /api/cart/items/<id> with `_method` (no JS needed).
 */
export function CartLineRow({ line }: { line: CartLineView }) {
  const action = `/api/cart/items/${line.id}`;
  const title = `${line.brand} ${line.article}`;
  return (
    <li
      className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-4 gap-y-4 rounded border border-line bg-card p-4 md:grid-cols-[4.5rem_minmax(0,1fr)_auto] md:gap-x-6 md:p-5"
      data-testid="cart-line"
    >
      <PartTile name={line.name} size="sm" className="md:size-18" />

      <div className="min-w-0">
        <p className="text-label text-muted wrap-anywhere">{line.brand}</p>
        <p className="mt-1 font-mono text-lg leading-tight font-semibold tracking-wide wrap-anywhere">
          {line.article}
        </p>
        <p className="mt-1 text-[0.9375rem] leading-snug wrap-anywhere">{line.name}</p>
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <StockBadge isLocal={line.isLocal} />
          {line.promiseText ? (
            <span
              className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted"
              data-testid="cart-line-promise"
            >
              <IconClock size={15} className="shrink-0 text-ink" />
              <span>
                Получение <span className="font-semibold text-ink">{line.promiseText}</span>
              </span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="col-span-2 flex min-w-0 items-baseline justify-between gap-4 border-t border-dashed border-line pt-4 md:col-span-1 md:flex-col md:items-end md:justify-start md:gap-0 md:border-0 md:pt-0 md:text-right">
        <p className="font-mono text-xs text-muted md:order-2 md:mt-1.5">
          <span className="whitespace-nowrap">{line.priceText}</span> за шт.
          {line.multiplicity > 1 ? `, продаётся по ${line.multiplicity} шт.` : null}
        </p>
        <Price
          size="sm"
          className="md:order-1 md:[--price-size:1.5rem]"
          data-testid="cart-line-total"
        >
          {line.lineTotalText}
        </Price>
      </div>

      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 md:col-span-2 md:col-start-2 md:border-t md:border-dashed md:border-line md:pt-4">
        <form method="post" action={action} className="flex items-center gap-2">
          <input type="hidden" name="_method" value="patch" />
          <label className="sr-only" htmlFor={`qty-${line.id}`}>
            Количество: {title}
          </label>
          <span className="hidden text-sm text-muted sm:inline">Кол-во</span>
          <div className="w-16 shrink-0">
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
              className={inputClass({ mono: true, className: 'h-11 text-center tabular-nums' })}
            />
          </div>
          <button type="submit" className={buttonClass({ variant: 'secondary' })}>
            Изменить
          </button>
        </form>
        <form method="post" action={action} className="ml-auto">
          <input type="hidden" name="_method" value="delete" />
          <button
            type="submit"
            className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-muted underline decoration-1 underline-offset-4 transition-colors hover:text-danger"
            aria-label={`Удалить: ${title}`}
          >
            Удалить
          </button>
        </form>
      </div>
    </li>
  );
}
