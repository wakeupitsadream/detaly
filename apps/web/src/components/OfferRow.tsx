import type { OfferView } from '@detaly/domain';
import { StockBadge } from './StockBadge';

/**
 * One offer: a card on phones, a grid row from `md` up. Supplier price and markup never
 * reach this component (OfferView carries the client price only).
 */
export function OfferRow({ offer }: { offer: OfferView }) {
  return (
    <li
      className="grid min-w-0 grid-cols-1 gap-3 rounded-card border border-line bg-card p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.9fr)_auto] md:items-center md:gap-4"
      data-testid="offer-row"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-wide text-muted uppercase wrap-anywhere">
          {offer.brand}
        </div>
        <div className="font-mono text-lg font-semibold wrap-anywhere">{offer.article}</div>
      </div>
      <div className="min-w-0">
        <div className="text-base wrap-anywhere">{offer.name}</div>
        {offer.multiplicity > 1 ? (
          <div className="mt-1 text-sm text-muted">Продаётся по {offer.multiplicity} шт.</div>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        {offer.excluded ? (
          <span className="inline-flex rounded-full bg-warn-soft px-2.5 py-1 text-xs font-medium text-warn">
            Не продаём онлайн
          </span>
        ) : (
          <StockBadge isLocal={offer.isLocal} />
        )}
        <span className="text-sm text-muted">
          {offer.excluded ? (
            `${offer.excludedReason ?? 'Маркируемый товар'}. Спросите в сервисе`
          ) : (
            <>
              Получение <span className="font-medium text-ink">{offer.promiseText}</span>
            </>
          )}
        </span>
      </div>
      <div className="min-w-0 md:text-right">
        {offer.excluded ? (
          <span className="text-sm text-muted">Цена в сервисе</span>
        ) : (
          <>
            <div className="text-xl font-bold whitespace-nowrap" data-testid="offer-price">
              {offer.priceText}
            </div>
            <div className="text-xs text-muted">в наличии: {offer.available} шт.</div>
          </>
        )}
      </div>
    </li>
  );
}
