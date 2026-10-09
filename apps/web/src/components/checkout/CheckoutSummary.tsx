import { formatPromise, formatRub, safeMul, type IsoDate, type RepricedLine } from '@detaly/domain';
import { IconCalendar, IconClock, IconPhone, IconPin } from '@/components/icons';
import { PICKUP_ADDRESS_UNKNOWN } from '@/components/order/OrderSections';
import { FitCheckedBadge } from '@/components/fit/FitBadge';
import { StockBadge } from '@/components/StockBadge';
import { cn } from '@/components/ui/cn';
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
  fitChecked = {},
  fitGuarantee = false,
}: {
  lines: readonly RepricedLine[];
  totalKop: number;
  promisedDate: IsoDate | null;
  /** «к …» per line id with the eta buffer (page data), never the raw supplier date. */
  linePromises: Readonly<Record<string, string | null>>;
  /** Step 4: lines the master checked under the VIN (page data): «Проверено мастером». */
  fitChecked?: Readonly<Record<string, boolean>>;
  /** FIT_GUARANTEE_ENABLED: the guarantee line under the badge. */
  fitGuarantee?: boolean;
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
              <p className="mt-0.5 line-clamp-2 text-small font-normal text-muted wrap-anywhere">
                {line.offer.name}
              </p>
              <p className="text-small font-normal whitespace-nowrap text-muted tabular-nums">
                {line.qty} × {formatRub(line.priceClientKop)}
              </p>
            </div>
            {fitChecked[line.id] ? (
              <FitCheckedBadge
                guarantee={fitGuarantee}
                className="col-span-2 sm:col-span-1 sm:col-start-2"
              />
            ) : null}
            {uniform ? null : (
              <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 sm:col-span-1 sm:col-start-2">
                {/* The scheme of the whole order is stated in «Оплата»: no payment tail here. */}
                <StockBadge isLocal={line.isLocal} payment={false} />
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
 * card of the «Получение» step is information, not a choice: a white card with a `line` frame
 * (brand frame and soft fill stay for the selected payment card below), the name, then address,
 * hours and phone in rows with brand icons like PickupCard, and one line about installation.
 */
export function PickupPoint({
  pickup,
  storageDays = null,
}: {
  pickup: Brand['pickup'];
  /** Days the ready order waits (settings pickup.window_*_days by the scheme shown). */
  storageDays?: number | null;
}) {
  return (
    <section
      className="min-w-0 rounded-tile border border-line bg-bg p-4 md:p-5"
      aria-labelledby="pickup-point-title"
      data-testid="pickup-point"
    >
      <p className="text-small text-muted">Самовывоз</p>
      <h3 id="pickup-point-title" className="mt-1 text-h3 wrap-anywhere">
        {pickup.name ?? 'Пункт выдачи'}
      </h3>
      <address className="mt-3 not-italic">
        <dl className="grid min-w-0 gap-2">
          <div className="flex min-w-0 items-start gap-3">
            <dt className="mt-0.5 shrink-0 text-brand">
              <IconPin size={22} />
              <span className="sr-only">Адрес</span>
            </dt>
            <dd className="min-w-0 text-body wrap-anywhere">
              {pickup.address ? (
                <span className="font-semibold">{pickup.address}</span>
              ) : (
                <span className="text-muted">{PICKUP_ADDRESS_UNKNOWN}</span>
              )}
            </dd>
          </div>
          {pickup.hours ? (
            <div className="flex min-w-0 items-start gap-3">
              <dt className="mt-0.5 shrink-0 text-brand">
                <IconClock size={22} />
                <span className="sr-only">Часы</span>
              </dt>
              <dd className="min-w-0 text-body wrap-anywhere">{pickup.hours}</dd>
            </div>
          ) : null}
          {pickup.phone ? (
            <div className="flex min-w-0 items-center gap-3">
              <dt className="shrink-0 text-brand">
                <IconPhone size={22} />
                <span className="sr-only">Телефон</span>
              </dt>
              <dd className="min-w-0">
                <a
                  className="inline-flex min-h-11 items-center text-body font-bold whitespace-nowrap text-ink tabular-nums underline decoration-line-strong underline-offset-4 hover:decoration-brand"
                  href={telHref(pickup.phone)}
                >
                  {pickup.phone}
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      </address>
      {storageDays ? (
        <p className="mt-3 border-t border-line pt-3 text-small" data-testid="pickup-storage">
          Храним {storageDays} {plural(storageDays, 'день', 'дня', 'дней')} после сообщения
          «Приехало».
        </p>
      ) : null}
      <p
        className={cn(
          'text-small font-normal',
          storageDays ? 'mt-2' : 'mt-3 border-t border-line pt-3',
        )}
      >
        Там же можно сразу поставить деталь. Установка — услуга сервиса, оплата там.
      </p>
    </section>
  );
}
