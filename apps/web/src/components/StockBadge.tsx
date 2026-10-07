import { Badge } from './ui/Badge';

/**
 * Exact texts are part of the contract (e2e, the domain's OfferView docs and the offer): do
 * not reword. docs/design-v2.md writes them with «·»; the dash stays until the contract moves.
 */
export const STOCK_BADGE_TEXT = {
  local: 'В Оренбурге — оплата при получении',
  order: 'Под заказ — предоплата',
} as const;

/** Where the part is, without how it is paid (a mixed proposal pays everything up front). */
export const STOCK_BADGE_PLACE = {
  local: 'В Оренбурге',
  order: 'Под заказ',
} as const;

/**
 * Where the part is and how it is paid: a round 14 px chip, green for Orenburg, blue to order.
 * `payment={false}` drops the payment tail where the whole basket is paid one way regardless
 * (a mixed proposal taken as one prepaid order): «оплата при получении» next to «предоплата
 * 100%» on one screen contradicted itself.
 */
export function StockBadge({ isLocal, payment = true }: { isLocal: boolean; payment?: boolean }) {
  const texts = payment ? STOCK_BADGE_TEXT : STOCK_BADGE_PLACE;
  return (
    <Badge tone={isLocal ? 'ok' : 'info'} data-testid="stock-badge">
      {isLocal ? texts.local : texts.order}
    </Badge>
  );
}
