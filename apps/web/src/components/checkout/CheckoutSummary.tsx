import { formatPromise, formatRub, safeMul, type IsoDate, type RepricedLine } from '@detaly/domain';
import { IconCalendar, IconClock, IconPhone, IconPin } from '@/components/icons';
import { PICKUP_ADDRESS_UNKNOWN } from '@/components/order/OrderSections';
import { StockBadge } from '@/components/StockBadge';
import { PartTile } from '@/components/ui/PartTile';
import { Price } from '@/components/ui/Price';
import { plural } from '@/lib/plural';
import type { Brand } from '@/server/brand';
import { telHref } from '@/server/brand';

/**
 * Lines of the order being checked out with client prices only (supplier prices never reach
 * the markup), the total and the date: a white card with a compact list and the total on a
 * grey strip at the bottom. The stock badge and the date stand on each line only in a mixed
 * order; when every line has the same stock and date they are said once (the payment card of
 * step 3 and «Получение к …» at the total), not repeated line by line.
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
  const first = lines[0];
  const uniform =
    first !== undefined &&
    lines.every(
      (line) =>
        line.isLocal === first.isLocal &&
        (linePromises[line.id] ?? null) === (linePromises[first.id] ?? null),
    );
  return (
    <section
      className="min-w-0 overflow-hidden rounded-tile border border-line bg-bg"
      aria-labelledby="checkout-items"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3 px-4 pt-4 md:px-5 md:pt-5">
        <h2 id="checkout-items" className="text-h3">
          Ваш заказ
        </h2>
        <span className="text-small text-muted">
          {lines.length} {plural(lines.length, 'позиция', 'позиции', 'позиций')}
        </span>
      </div>
      <ul className="divide-y divide-line px-4 md:px-5">
        {lines.map((line) => (
          <li
            key={line.id}
            className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 py-4"
            data-testid="checkout-line"
          >
            <PartTile name={line.offer.name} size="sm" />
            <div className="min-w-0 self-center">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <p className="min-w-0 text-[1.0625rem] leading-snug font-bold wrap-anywhere">
                  {line.offer.brand} <span className="tabular-nums">{line.offer.article}</span>
                </p>
                <p className="shrink-0 text-[1.0625rem] font-bold whitespace-nowrap tabular-nums">
                  {formatRub(safeMul(line.priceClientKop, line.qty))}
                </p>
              </div>
              <p className="mt-0.5 line-clamp-1 text-small font-normal text-muted wrap-anywhere">
                {line.offer.name}
              </p>
              <p className="text-small font-normal whitespace-nowrap text-muted tabular-nums">
                {line.qty} × {formatRub(line.priceClientKop)}
              </p>
            </div>
            {uniform ? null : (
              <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 sm:col-span-1 sm:col-start-2">
                <StockBadge isLocal={line.isLocal} />
                {linePromises[line.id] ? (
                  <span
                    className="inline-flex items-center gap-1.5 text-small"
                    data-testid="checkout-line-promise"
                  >
                    <IconCalendar size={18} className="shrink-0 text-brand" />
                    <span>
                      Получение{' '}
                      <span className="font-bold whitespace-nowrap">{linePromises[line.id]}</span>
                    </span>
                  </span>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="bg-surface px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="text-body font-semibold">Итого</span>
          <Price size="lg" data-testid="checkout-total">
            {formatRub(totalKop)}
          </Price>
        </div>
        {promisedDate ? (
          <p className="mt-2 flex items-start gap-2 text-body" data-testid="checkout-promise">
            <IconCalendar size={22} className="shrink-0 text-brand" />
            <span>
              Получение <span className="font-bold">{formatPromise(promisedDate)}</span>
            </span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Pickup point from env (PICKUP_*): the only way to receive an order in 1A (no courier). The
 * card of the «Получение» step: a pin with the name and address, hours, the phone and one line
 * about the installation right there.
 */
export function PickupPoint({ pickup }: { pickup: Brand['pickup'] }) {
  return (
    <section
      className="min-w-0 rounded-tile border-2 border-brand bg-brand-soft/40 p-4 md:p-5"
      aria-labelledby="pickup-point-title"
      data-testid="pickup-point"
    >
      <div className="flex min-w-0 items-start gap-3">
        {/* A pin, not the partner's logo: its lettering is unreadable at 56 px. */}
        <span className="grid size-14 shrink-0 place-items-center rounded-control bg-bg text-brand">
          <IconPin size={28} />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-small text-muted">Самовывоз</p>
          <h3 id="pickup-point-title" className="text-h3 wrap-anywhere">
            {pickup.name ?? 'Пункт выдачи'}
          </h3>
          {pickup.address ? <p className="text-body wrap-anywhere">{pickup.address}</p> : null}
          {pickup.hours ? (
            <p className="flex items-center gap-1.5 text-small font-normal text-muted wrap-anywhere">
              <IconClock size={18} className="shrink-0" />
              {pickup.hours}
            </p>
          ) : null}
          {pickup.phone ? (
            <p>
              <a
                className="inline-flex min-h-11 items-center gap-1.5 font-semibold whitespace-nowrap text-brand underline underline-offset-4"
                href={telHref(pickup.phone)}
              >
                <IconPhone size={18} className="shrink-0" />
                {pickup.phone}
              </a>
            </p>
          ) : null}
          {!pickup.name && !pickup.address ? (
            <p className="text-small text-muted">{PICKUP_ADDRESS_UNKNOWN}</p>
          ) : null}
        </div>
      </div>
      <p className="mt-3 border-t border-brand/15 pt-3 text-small font-normal">
        Там же можно сразу поставить деталь. Установка — услуга сервиса, оплата там.
      </p>
    </section>
  );
}
