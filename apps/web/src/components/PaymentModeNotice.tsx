import type { PaymentNotice } from '@/server/cart/summary';

export const SPLIT_BUTTON_TEXT = 'Разделить на два заказа';
export const SPLIT_EXPLANATION =
  'Сначала оформим детали из Оренбурга с оплатой при получении, затем — под заказ.';

/**
 * How the cart will be paid (docs/phase-1a-implementation.md section 5.2): the scheme
 * explained in words for a homogeneous cart; for a mixed one the prepayment notice and, when
 * the Orenburg part alone qualifies for payment on handover, "Разделить на два заказа"
 * (/checkout?part=local). Links are plain anchors: /checkout re-prices on render.
 */
export function PaymentModeNotice({
  payment,
  checkoutOpen,
}: {
  payment: PaymentNotice;
  /** Checkout gate open and the order minimums met; otherwise no checkout links. */
  checkoutOpen: boolean;
}) {
  return (
    <section
      className="space-y-3 rounded-card border border-line bg-card p-4"
      aria-labelledby="payment-mode-title"
      data-testid="payment-mode-notice"
    >
      <h2 id="payment-mode-title" className="text-lg font-semibold">
        Способ оплаты
      </h2>
      {payment.sentences.map((sentence) => (
        <p key={sentence} className="text-sm text-muted">
          {sentence}
        </p>
      ))}
      {payment.mixed && checkoutOpen ? (
        payment.offerSplit ? (
          <div className="space-y-2">
            <a
              href="/checkout?part=local"
              className="inline-flex h-11 max-w-full items-center rounded-xl border border-ink px-4 font-semibold hover:bg-ink hover:text-white"
              data-testid="split-order"
            >
              {SPLIT_BUTTON_TEXT}
            </a>
            <p className="text-sm text-muted">{SPLIT_EXPLANATION}</p>
          </div>
        ) : (
          <a href="/checkout" className="inline-block min-h-11 py-2 text-sm font-medium underline">
            Оформить одним заказом
          </a>
        )
      ) : null}
    </section>
  );
}
