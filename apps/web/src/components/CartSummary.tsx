import type { OrderMinimumsResult } from '@detaly/domain';

/**
 * Sum, the order's date, the minimum-order hint and "Оформить заказ" — or the checkout gate's
 * text instead of the button while online checkout is closed.
 */
export function CartSummary({
  subtotalText,
  itemsCount,
  promiseText,
  minimums,
  gate,
}: {
  subtotalText: string;
  itemsCount: number;
  promiseText: string | null;
  minimums: OrderMinimumsResult;
  gate: { open: true } | { open: false; message: string };
}) {
  return (
    <section
      className="space-y-3 rounded-card border border-line bg-card p-4"
      aria-label="Итого"
      data-testid="cart-summary"
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <span className="text-muted">Итого, {itemsCount} шт.</span>
        <span className="text-2xl font-bold whitespace-nowrap" data-testid="cart-total">
          {subtotalText}
        </span>
      </div>
      {promiseText ? (
        <p className="text-sm text-muted">
          Получение заказа <span className="font-medium text-ink">{promiseText}</span>
        </p>
      ) : null}
      {!minimums.ok ? (
        <p
          className="rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn"
          data-testid="cart-minimum"
        >
          {minimums.message}
        </p>
      ) : null}
      {gate.open ? (
        minimums.ok ? (
          <a
            href="/checkout"
            className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-accent px-5 font-semibold text-white hover:bg-accent-strong"
            data-testid="checkout-link"
          >
            Оформить заказ
          </a>
        ) : (
          <span
            className="inline-flex h-12 w-full cursor-not-allowed items-center justify-center rounded-xl bg-line px-5 font-semibold text-muted"
            aria-disabled="true"
          >
            Оформить заказ
          </span>
        )
      ) : (
        <p className="text-sm text-muted" data-testid="checkout-closed">
          {gate.message}
        </p>
      )}
    </section>
  );
}
