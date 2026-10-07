import type { CartLineView } from '@/server/cart/summary';
import { QtyStepper } from './checkout/QtyStepper';
import { IconCalendar, IconTrash } from './icons';
import { StockBadge } from './StockBadge';
import { PartTile } from './ui/PartTile';
import { Price } from './ui/Price';

/**
 * One cart line as a card (docs/design-v2.md, «Корзина»): the part tile, brand and article,
 * the name, the stock badge and the date; under them the round quantity stepper and the line
 * total. «Удалить» is a round icon button in the corner, named for a screen reader. All forms
 * are plain POSTs to /api/cart/items/<id> with `_method` (no JS needed).
 */
export function CartLineRow({ line }: { line: CartLineView }) {
  const action = `/api/cart/items/${line.id}`;
  const title = `${line.brand} ${line.article}`;
  return (
    <li
      className="relative grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-4 gap-y-4 rounded-tile border border-line bg-bg p-4 md:grid-cols-[4.5rem_minmax(0,1fr)] md:gap-x-5 md:p-5"
      data-testid="cart-line"
    >
      <PartTile name={line.name} size="sm" className="md:size-18 md:rounded-tile" />

      <div className="min-w-0 self-center pr-11">
        {/* A heading per line (h3 under «Товары в корзине»): a screen reader steps line to
            line. */}
        <h3 className="text-[1.0625rem] leading-snug font-bold wrap-anywhere">
          {line.brand} <span className="tabular-nums">{line.article}</span>
        </h3>
        <p className="mt-0.5 line-clamp-2 text-small font-normal text-muted wrap-anywhere">
          {line.name}
        </p>
      </div>

      <div className="col-span-2 -mt-1 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 md:col-span-1 md:col-start-2">
        <StockBadge isLocal={line.isLocal} />
        {line.promiseText ? (
          <span
            className="inline-flex min-w-0 items-center gap-1.5 text-small"
            data-testid="cart-line-promise"
          >
            <IconCalendar size={20} className="shrink-0 text-brand" />
            <span>
              Получение <span className="font-bold whitespace-nowrap">{line.promiseText}</span>
            </span>
          </span>
        ) : null}
      </div>

      <form method="post" action={action} className="absolute top-2 right-2 md:top-3 md:right-3">
        <input type="hidden" name="_method" value="delete" />
        <button
          type="submit"
          className="grid size-11 place-items-center rounded-full text-muted transition-colors hover:bg-danger-soft hover:text-danger"
          aria-label={`Удалить: ${title}`}
          title="Удалить"
        >
          <IconTrash size={22} />
        </button>
      </form>

      <div className="col-span-2 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-line pt-4 md:col-start-2 md:col-end-3">
        <QtyStepper
          action={action}
          lineId={line.id}
          qty={line.qty}
          step={line.multiplicity}
          maxQty={line.maxQty}
          title={title}
        />
        <div className="ml-auto min-w-0 text-right">
          <Price size="md" className="block" data-testid="cart-line-total">
            {line.lineTotalText}
          </Price>
          <p className="mt-1 text-small font-normal text-muted tabular-nums">
            <span className="whitespace-nowrap">{line.priceText}</span> за шт.
            {line.multiplicity > 1 ? `, продаётся по ${line.multiplicity} шт.` : null}
          </p>
        </div>
      </div>
    </li>
  );
}
