import { formatPromise, formatRub, safeMul, type IsoDate, type RepricedLine } from '@detaly/domain';
import { StockBadge } from '@/components/StockBadge';
import type { Brand } from '@/server/brand';
import { telHref } from '@/server/brand';

/**
 * Lines of the order being checked out with client prices only (supplier prices never reach
 * the markup), the total and the delivery promise.
 */
export function CheckoutSummary({
  lines,
  totalKop,
  promisedDate,
  linePromises,
}: {
  lines: readonly RepricedLine[];
  totalKop: number;
  promisedDate: IsoDate | null;
  /** «к …» per line id with the eta buffer (page data), never the raw supplier date. */
  linePromises: Readonly<Record<string, string | null>>;
}) {
  return (
    <section className="space-y-3" aria-labelledby="checkout-items">
      <h2 id="checkout-items" className="text-lg font-semibold">
        Состав заказа
      </h2>
      <ul className="space-y-3">
        {lines.map((line) => (
          <li
            key={line.id}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 rounded-card border border-line bg-card p-4"
            data-testid="checkout-line"
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold tracking-wide text-muted uppercase wrap-anywhere">
                {line.offer.brand}
              </div>
              <div className="font-mono font-semibold wrap-anywhere">{line.offer.article}</div>
              <div className="text-sm wrap-anywhere">{line.offer.name}</div>
            </div>
            <div className="text-right">
              <div className="font-semibold whitespace-nowrap">
                {formatRub(safeMul(line.priceClientKop, line.qty))}
              </div>
              <div className="text-xs whitespace-nowrap text-muted">
                {line.qty} × {formatRub(line.priceClientKop)}
              </div>
            </div>
            <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2">
              <StockBadge isLocal={line.isLocal} />
              {linePromises[line.id] ? (
                <span className="text-sm text-muted" data-testid="checkout-line-promise">
                  {linePromises[line.id]}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-card border border-line bg-card p-4">
        <span className="font-semibold">Итого</span>
        <span className="text-2xl font-bold whitespace-nowrap" data-testid="checkout-total">
          {formatRub(totalKop)}
        </span>
        {promisedDate ? (
          <p className="w-full text-sm text-muted" data-testid="checkout-promise">
            Получение <span className="font-medium text-ink">{formatPromise(promisedDate)}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Pickup point from env (PICKUP_*): the only way to receive an order in 1A (no courier). */
export function PickupPoint({ pickup }: { pickup: Brand['pickup'] }) {
  return (
    <section
      className="space-y-1 rounded-card border border-line bg-card p-4"
      data-testid="pickup-point"
    >
      <h2 className="font-semibold">Самовывоз</h2>
      {pickup.name ? <p className="wrap-anywhere">{pickup.name}</p> : null}
      {pickup.address ? <p className="text-sm text-muted wrap-anywhere">{pickup.address}</p> : null}
      {pickup.hours ? <p className="text-sm text-muted">{pickup.hours}</p> : null}
      {pickup.phone ? (
        <p className="text-sm">
          <a className="whitespace-nowrap underline" href={telHref(pickup.phone)}>
            {pickup.phone}
          </a>
        </p>
      ) : null}
      {!pickup.name && !pickup.address ? (
        <p className="text-sm text-muted">Адрес пункта выдачи пришлём вместе со статусом заказа.</p>
      ) : null}
    </section>
  );
}
