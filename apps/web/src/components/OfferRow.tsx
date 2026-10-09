import type { OfferView } from '@detaly/domain';
import { telHref } from '@/server/brand';
import type { InstallPlanView } from '@/server/install/types';
import { AddToCartForm } from './AddToCartForm';
import { FitSearchLink } from './fit/FitSearchLink';
import { IconCalendar, IconPhone, IconWallet } from './icons';
import { InstallLine } from './install/InstallLine';
import { StockBadge } from './StockBadge';
import { Badge } from './ui/Badge';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';
import { PartTile } from './ui/PartTile';
import { Price } from './ui/Price';

/** A hint on a row that wins the group on time or on money. */
export type OfferMark = 'fastest' | 'cheapest';

const MARK_TEXT: Record<OfferMark, string> = {
  fastest: 'Быстрее всего',
  cheapest: 'Дешевле всего',
};

/** «в Оренбурге: 6 шт.» / «у поставщика: 24 шт.»: where the count is, matching the badge. */
export function stockCountText(offer: Pick<OfferView, 'isLocal' | 'available'>): string {
  return `${offer.isLocal ? 'в Оренбурге' : 'у поставщика'}: ${offer.available} шт.`;
}

/**
 * The visible count under the price: «Есть 6 шт.» for the Orenburg stock, «У поставщика 24 шт.»
 * for an order (a bare «Есть 24 шт.» under «Под заказ» reads as «on the shelf here»).
 */
export function stockCountLine(offer: Pick<OfferView, 'isLocal' | 'available'>): string {
  return offer.isLocal ? `Есть ${offer.available} шт.` : `У поставщика ${offer.available} шт.`;
}

/**
 * Plain words for an excluded (marked) good: «Масла — только в сервисе» from the rule's reason
 * «Маркируемый товар: масла». Where it is sold, not «мы продаём в сервисе»: the shop is an
 * independent store and the service only its pickup point (decision of 08.10). The reason
 * itself stays as it is (the worker reads it).
 */
export function excludedClientText(reason: string | null): string {
  const category = /^Маркируемый товар:\s*(.+)$/u.exec(reason?.trim() ?? '')?.[1]?.trim();
  if (!category) return 'Этот товар — только в сервисе';
  return `${category.charAt(0).toUpperCase()}${category.slice(1)} — только в сервисе`;
}

/**
 * One offer as a card (docs/design-v2.md, OfferCard): a 72 px tile with the category glyph,
 * brand and article, the name, the stock badge, the arrival date, one line of «Машина готова…»
 * when a lift window is planned, the price and «В корзину». Phones stack it with the button
 * across the card; from lg it is one row of four columns. Supplier price and markup never reach
 * this component (OfferView carries the client price only). Excluded (marked) goods get no
 * «В корзину» button. Step 4: «Проверить под мою машину» under it adds the offer and opens the
 * fit check form of its cart line (components/fit/FitSearchLink).
 */
export function OfferRow({
  offer,
  searchArticleNorm,
  orderingOpen = true,
  install,
  marks,
  contactPhone = null,
}: {
  offer: OfferView;
  /** Normalized article of the search query the offer was found by. */
  searchArticleNorm: string;
  /**
   * Online checkout is open (checkout gate). While it is closed there is no "В корзину": a
   * cart that cannot be checked out is a dead end, the page offers the phone instead.
   */
  orderingOpen?: boolean;
  /** Nearest lift slot for this offer; undefined or null: no install line. */
  install?: InstallPlanView | null;
  /** «Быстрее всего» / «Дешевле всего» (OfferGroup decides). */
  marks?: readonly OfferMark[];
  /** The point's phone: the call button of an excluded good; none without a phone. */
  contactPhone?: string | null;
}) {
  const sellable = !offer.excluded && offer.available >= offer.multiplicity;
  const canAdd = orderingOpen && sellable;
  const title = `${offer.brand} ${offer.article}`;
  return (
    <li
      className={cn(
        'grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-4 rounded-tile border bg-bg p-4',
        'transition-colors duration-150 hover:border-line-strong md:p-5',
        'lg:grid-cols-[4.5rem_minmax(0,1.1fr)_minmax(0,1fr)_13.5rem] lg:items-center lg:gap-x-8',
        offer.excluded ? 'border-dashed border-line-strong' : 'border-line',
      )}
      data-testid="offer-row"
    >
      <PartTile name={offer.name} size="md" className="self-start lg:self-center" />

      <div className="min-w-0 self-center">
        {marks && marks.length > 0 ? (
          <p className="mb-2 flex flex-wrap gap-1.5">
            {marks.map((mark) => (
              // Neutral with an icon: red is the brand and the error, green the Orenburg stock.
              <Badge
                key={mark}
                tone="plain"
                icon={
                  mark === 'fastest' ? (
                    <IconCalendar size={16} className="shrink-0 text-brand" />
                  ) : (
                    <IconWallet size={16} className="shrink-0 text-brand" />
                  )
                }
                data-testid={`offer-mark-${mark}`}
              >
                {MARK_TEXT[mark]}
              </Badge>
            ))}
          </p>
        ) : null}
        {/* A heading per offer (h3 under «Точное совпадение» / «Аналоги»): a screen reader
            steps offer to offer instead of reading five «Фильтр масляный» in a row. */}
        <h3 className="text-[1.0625rem] leading-snug font-bold wrap-anywhere lg:text-[1.25rem]">
          {offer.brand} <span className="tabular-nums">{offer.article}</span>
        </h3>
        <p className="mt-0.5 line-clamp-2 text-small font-normal text-muted wrap-anywhere">
          {offer.name}
        </p>
        {offer.multiplicity > 1 ? (
          <p className="mt-1 text-small text-ink">Продаётся по {offer.multiplicity} шт.</p>
        ) : null}
      </div>

      <div className="col-span-2 flex min-w-0 flex-col items-start gap-2.5 lg:col-span-1">
        {offer.excluded ? (
          <>
            <Badge tone="danger">Не продаём онлайн</Badge>
            <p className="text-small font-normal text-muted" data-testid="offer-excluded-text">
              {excludedClientText(offer.excludedReason)}
            </p>
          </>
        ) : (
          <>
            <StockBadge isLocal={offer.isLocal} />
            <p className="flex min-w-0 items-start gap-2 text-small font-normal">
              <IconCalendar size={20} className="shrink-0 text-brand" />
              <span className="min-w-0">
                Получение <span className="font-bold whitespace-nowrap">{offer.promiseText}</span>
              </span>
            </p>
            {install ? <InstallLine plan={install} /> : null}
          </>
        )}
      </div>

      <div
        className={cn(
          'col-span-2 flex min-w-0 flex-col gap-3 border-t border-line pt-4',
          'md:flex-row md:items-center md:justify-between',
          'lg:col-span-1 lg:flex-col lg:items-stretch lg:border-0 lg:pt-0',
        )}
      >
        {offer.excluded ? (
          contactPhone ? (
            <a
              href={telHref(contactPhone)}
              className={cn(
                buttonClass({ variant: 'secondary', size: 'md' }),
                'w-full whitespace-nowrap md:w-auto lg:w-full',
              )}
              data-testid="offer-excluded-call"
            >
              <IconPhone size={20} />
              Узнать цену
            </a>
          ) : (
            <p className="text-small text-muted">Цена — в сервисе</p>
          )
        ) : (
          <div className="flex min-w-0 items-baseline justify-between gap-3 lg:flex-col lg:items-start lg:gap-1">
            <Price data-testid="offer-price">{offer.priceText}</Price>
            <span className="text-caption text-muted tabular-nums" title={stockCountText(offer)}>
              {stockCountLine(offer)}
            </span>
          </div>
        )}
        {sellable ? (
          <div className="flex w-full min-w-0 flex-col gap-1 md:w-auto md:min-w-52 lg:w-full">
            {canAdd ? (
              <AddToCartForm
                q={searchArticleNorm}
                offerId={offer.id}
                qty={offer.multiplicity}
                title={title}
              />
            ) : null}
            <FitSearchLink
              q={searchArticleNorm}
              offerId={offer.id}
              qty={offer.multiplicity}
              title={title}
              open={orderingOpen}
              phone={contactPhone}
            />
          </div>
        ) : null}
      </div>
    </li>
  );
}
