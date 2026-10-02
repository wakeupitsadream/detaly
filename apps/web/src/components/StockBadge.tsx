import { Badge } from './ui/Badge';

/** Exact texts are part of the contract (e2e and the offer): do not reword. */
export const STOCK_BADGE_TEXT = {
  local: 'В Оренбурге — оплата при получении',
  order: 'Под заказ — предоплата',
} as const;

export function StockBadge({ isLocal }: { isLocal: boolean }) {
  return (
    <Badge tone={isLocal ? 'ok' : 'info'} data-testid="stock-badge">
      {isLocal ? STOCK_BADGE_TEXT.local : STOCK_BADGE_TEXT.order}
    </Badge>
  );
}
