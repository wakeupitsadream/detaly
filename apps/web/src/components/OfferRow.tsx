import type { OfferView } from '@detaly/domain';
import type { InstallPlanView } from '@/server/install/types';
import { AddToCartForm } from './AddToCartForm';
import { IconCalendar } from './icons';
import { InstallLine } from './install/InstallLine';
import { StockBadge } from './StockBadge';
import { Badge } from './ui/Badge';
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
 * One offer as a card (docs/design-v2.md, OfferCard): a 72 px tile with the category glyph,
 * brand and article, the name, the stock badge, the arrival date, one line of «Машина готова…»
 * when a lift window is planned, the price and «В корзину». Phones stack it with the button
 * across the card; from lg it is one row of four columns. Supplier price and markup never reach
 * this component (OfferView carries the client price only). Excluded (marked) goods get no
 * «В корзину» button.
 */
export function OfferRow({
  offer,
  searchArticleNorm,
  orderingOpen = true,
  install,
  marks,
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
}) {
  const canAdd = orderingOpen && !offer.excluded && offer.available >= offer.multiplicity;
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
              <Badge
                key={mark}
                tone={mark === 'fastest' ? 'ok' : 'brand'}
                data-testid={`offer-mark-${mark}`}
              >
                {MARK_TEXT[mark]}
              </Badge>
            ))}
          </p>
        ) : null}
        <p className="text-[1.0625rem] leading-snug font-bold wrap-anywhere lg:text-[1.25rem]">
          {offer.brand} <span className="tabular-nums">{offer.article}</span>
        </p>
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
            <p className="text-small font-normal text-muted">
              {offer.excludedReason ?? 'Маркируемый товар'} — спросите в сервисе
            </p>
          </>
        ) : (
          <>
            <StockBadge isLocal={offer.isLocal} />
            <p className="flex min-w-0 items-start gap-2 text-small font-normal">
              <IconCalendar size={20} className="shrink-0 text-brand" />
              <span className="min-w-0">
                Привезём <span className="font-bold whitespace-nowrap">{offer.promiseText}</span>
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
          <p className="text-small text-muted">Цена — в сервисе</p>
        ) : (
          <div className="flex min-w-0 items-baseline justify-between gap-3 lg:flex-col lg:items-start lg:gap-1">
            <Price data-testid="offer-price">{offer.priceText}</Price>
            <span className="text-caption text-muted tabular-nums" title={stockCountText(offer)}>
              Есть {offer.available} шт.
            </span>
          </div>
        )}
        {canAdd ? (
          <AddToCartForm
            q={searchArticleNorm}
            offerId={offer.id}
            qty={offer.multiplicity}
            title={title}
            className="w-full md:w-auto md:min-w-52 lg:w-full"
          />
        ) : null}
      </div>
    </li>
  );
}
