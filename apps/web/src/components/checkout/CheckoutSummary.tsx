import { formatPromise, formatRub, safeMul, type IsoDate, type RepricedLine } from '@detaly/domain';
import { IconClock, IconPhone, IconPin } from '@/components/icons';
import { PICKUP_ADDRESS_UNKNOWN } from '@/components/order/OrderSections';
import { SheetTitle } from '@/components/page/SheetTitle';
import { StockBadge } from '@/components/StockBadge';
import { Price } from '@/components/ui/Price';
import { plural } from '@/lib/plural';
import type { Brand } from '@/server/brand';
import { telHref } from '@/server/brand';

/**
 * Lines of the order being checked out with client prices only (supplier prices never reach
 * the markup), the total and the delivery promise. A key card: ink frame with corner marks,
 * the total on a paper strip at the bottom.
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
    <section
      className="corner-marks min-w-0 rounded border border-ink bg-card"
      aria-labelledby="checkout-items"
    >
      <div className="px-5 pt-5 md:px-6 md:pt-6">
        <SheetTitle
          id="checkout-items"
          tight
          aside={
            <span className="font-mono text-xs text-muted">
              {lines.length} {plural(lines.length, 'позиция', 'позиции', 'позиций')}
            </span>
          }
        >
          Состав заказа
        </SheetTitle>
        <ul className="divide-y divide-dashed divide-line">
          {lines.map((line) => (
            <li
              key={line.id}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 py-4"
              data-testid="checkout-line"
            >
              <div className="min-w-0">
                <p className="text-label text-muted wrap-anywhere">{line.offer.brand}</p>
                <p className="mt-0.5 font-mono font-semibold tracking-wide wrap-anywhere">
                  {line.offer.article}
                </p>
                <p className="text-sm wrap-anywhere">{line.offer.name}</p>
              </div>
              <div className="text-right">
                <p className="font-semibold whitespace-nowrap tabular-nums">
                  {formatRub(safeMul(line.priceClientKop, line.qty))}
                </p>
                <p className="mt-0.5 font-mono text-xs whitespace-nowrap text-muted">
                  {line.qty} × {formatRub(line.priceClientKop)}
                </p>
              </div>
              <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
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
      </div>
      <div className="border-t border-ink bg-paper px-5 py-4 md:px-6 md:py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="text-label text-muted">Итого</span>
          <Price size="lg" data-testid="checkout-total">
            {formatRub(totalKop)}
          </Price>
        </div>
        {promisedDate ? (
          <p
            className="mt-3 flex items-start gap-2 text-sm text-muted"
            data-testid="checkout-promise"
          >
            <IconClock size={16} className="mt-0.5 shrink-0 text-ink" />
            <span>
              Получение{' '}
              <span className="font-semibold text-ink">{formatPromise(promisedDate)}</span>
            </span>
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
      className="min-w-0 rounded border border-line bg-card p-5 md:p-6"
      data-testid="pickup-point"
    >
      <SheetTitle>Самовывоз</SheetTitle>
      <div className="flex min-w-0 gap-3">
        <IconPin size={20} className="mt-0.5 shrink-0 text-accent-ink" />
        <div className="min-w-0 space-y-1">
          {pickup.name ? <p className="font-semibold wrap-anywhere">{pickup.name}</p> : null}
          {pickup.address ? <p className="wrap-anywhere">{pickup.address}</p> : null}
          {pickup.hours ? (
            <p className="flex items-center gap-1.5 text-sm text-muted">
              <IconClock size={14} className="shrink-0" />
              {pickup.hours}
            </p>
          ) : null}
          {pickup.phone ? (
            <p className="text-sm">
              <a
                className="inline-flex min-h-8 items-center gap-1.5 font-medium whitespace-nowrap underline underline-offset-4"
                href={telHref(pickup.phone)}
              >
                <IconPhone size={14} className="shrink-0" />
                {pickup.phone}
              </a>
            </p>
          ) : null}
          {!pickup.name && !pickup.address ? (
            <p className="text-sm text-muted">{PICKUP_ADDRESS_UNKNOWN}</p>
          ) : null}
        </div>
      </div>
      <p className="mt-4 border-t border-dashed border-line pt-3 text-sm text-muted">
        Заказ выдаём прямо в автосервисе: там же детали можно сразу поставить. Установка&nbsp;—
        услуга сервиса, оплачивается там.
      </p>
    </section>
  );
}
