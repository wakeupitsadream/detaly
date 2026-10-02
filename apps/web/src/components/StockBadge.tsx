export const STOCK_BADGE_TEXT = {
  local: 'В Оренбурге — оплата при получении',
  order: 'Под заказ — предоплата',
} as const;

export function StockBadge({ isLocal }: { isLocal: boolean }) {
  return (
    <span
      className={`inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-xs font-medium ${
        isLocal ? 'bg-local-soft text-local' : 'bg-order-soft text-order'
      }`}
      data-testid="stock-badge"
    >
      {isLocal ? STOCK_BADGE_TEXT.local : STOCK_BADGE_TEXT.order}
    </span>
  );
}
