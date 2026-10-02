import type { OfferView } from '@detaly/domain';
import type { InstallPlanView } from '@/server/install/types';
import { AddToCartForm } from './AddToCartForm';
import { IconClock } from './icons';
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
 * One offer. Desktop: a row of four columns (tile | brand, article, name | stock, date, lift
 * slot | price and "В корзину"). Phones: tile beside the article, the dates under it and the
 * price with the button as the last line. Supplier price and markup never reach this component
 * (OfferView carries the client price only). Excluded (marked) goods get no "В корзину" button.
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
  /** Nearest lift slot for this offer; undefined: the page does not plan installs. */
  install?: InstallPlanView | null;
  /** «Быстрее всего» / «Дешевле всего» (OfferGroup decides). */
  marks?: readonly OfferMark[];
}) {
  const canAdd = orderingOpen && !offer.excluded && offer.available >= offer.multiplicity;
  const title = `${offer.brand} ${offer.article}`;
  return (
    <li
      className={cn(
        'group/offer grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-4 gap-y-4 rounded border bg-card p-4',
        'transition-[border-color,transform] duration-150 hover:-translate-y-px hover:border-ink',
        // The article column is as wide as its text (up to 20rem): the stock and the dates sit
        // right next to it instead of across a dead gap.
        'md:grid-cols-[4.5rem_fit-content(20rem)_minmax(0,1fr)_auto] md:items-center md:gap-x-8 md:p-5',
        offer.excluded ? 'border-line border-dashed' : 'border-line',
      )}
      data-testid="offer-row"
    >
      <PartTile name={offer.name} size="sm" className="md:size-18" />

      <div className="min-w-0 self-center">
        {marks && marks.length > 0 ? (
          <p className="mb-2 flex flex-wrap gap-1.5">
            {marks.map((mark) => (
              <Badge
                key={mark}
                tone={mark === 'fastest' ? 'ok' : 'neutral'}
                className="font-semibold"
                data-testid={`offer-mark-${mark}`}
              >
                {MARK_TEXT[mark]}
              </Badge>
            ))}
          </p>
        ) : null}
        <p className="text-label text-muted wrap-anywhere">{offer.brand}</p>
        <p className="mt-1 font-mono text-lg leading-tight font-semibold tracking-wide wrap-anywhere md:text-xl">
          {offer.article}
        </p>
        <p className="mt-1 text-[0.9375rem] leading-snug wrap-anywhere">{offer.name}</p>
        {offer.multiplicity > 1 ? (
          <p className="mt-1 text-sm text-muted">Продаётся по {offer.multiplicity} шт.</p>
        ) : null}
      </div>

      <div className="col-span-2 flex min-w-0 flex-col items-start gap-2 border-t border-dashed border-line pt-3 md:col-span-1 md:border-0 md:pt-0">
        {offer.excluded ? (
          <>
            <Badge tone="danger">Не продаём онлайн</Badge>
            <p className="text-sm text-muted">
              {offer.excludedReason ?? 'Маркируемый товар'}. Спросите в сервисе
            </p>
          </>
        ) : (
          <>
            <StockBadge isLocal={offer.isLocal} />
            <p className="flex min-w-0 items-start gap-1.5 text-sm text-muted">
              <IconClock size={16} className="mt-0.5 shrink-0 text-ink" />
              <span className="min-w-0">
                Получение <span className="font-semibold text-ink">{offer.promiseText}</span>
              </span>
            </p>
            {install !== undefined ? <InstallLine plan={install} /> : null}
          </>
        )}
      </div>

      <div className="col-span-2 flex min-w-0 items-center gap-4 md:col-span-1 md:w-44 md:flex-col md:items-stretch md:gap-3 md:text-right">
        {offer.excluded ? (
          <p className="text-sm text-muted">Цена в сервисе</p>
        ) : (
          <div className="shrink-0">
            <Price
              data-testid="offer-price"
              className="[--price-size:1.5rem] md:[--price-size:1.75rem]"
            >
              {offer.priceText}
            </Price>
            <p className="mt-1.5 font-mono text-xs text-muted">{stockCountText(offer)}</p>
          </div>
        )}
        {canAdd ? (
          <AddToCartForm
            q={searchArticleNorm}
            offerId={offer.id}
            qty={offer.multiplicity}
            title={title}
            className="flex-1 md:flex-none"
          />
        ) : null}
      </div>
    </li>
  );
}
