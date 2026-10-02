import type { OrderMinimumsResult } from '@detaly/domain';
import { telHref } from '@/server/brand';

/**
 * Sum, the order's date, the minimum-order hint and "Оформить заказ" — or, while online
 * checkout is closed, the gate's text with a call button (every closed reason), so the client
 * who collected a cart still has a way to order.
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
  gate: { open: true } | { open: false; message: string; phone: string | null };
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
        <div className="space-y-3" data-testid="checkout-closed">
          <p className="text-sm text-muted">{gate.message}</p>
          {gate.phone ? (
            <a
              href={telHref(gate.phone)}
              className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-accent px-5 font-semibold whitespace-nowrap text-white hover:bg-accent-strong"
              data-testid="call-to-order"
            >
              Позвонить {gate.phone}
            </a>
          ) : null}
        </div>
      )}
    </section>
  );
}
