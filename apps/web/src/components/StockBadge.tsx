import { Badge } from './ui/Badge';

/**
 * Exact texts are part of the contract (e2e, the domain's OfferView docs and the offer): do
 * not reword. docs/design-v2.md writes them with «·»; the dash stays until the contract moves.
 */
export const STOCK_BADGE_TEXT = {
  local: 'В Оренбурге — оплата при получении',
  order: 'Под заказ — предоплата',
} as const;

/** Where the part is and how it is paid: a round 14 px chip, green for Orenburg, blue to order. */
export function StockBadge({ isLocal }: { isLocal: boolean }) {
  return (
    <Badge tone={isLocal ? 'ok' : 'info'} data-testid="stock-badge">
      {isLocal ? STOCK_BADGE_TEXT.local : STOCK_BADGE_TEXT.order}
    </Badge>
  );
}
