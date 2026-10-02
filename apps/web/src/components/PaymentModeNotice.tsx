import type { PaymentNotice } from '@/server/cart/summary';
import { IconShield } from './icons';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';

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
      className={cn(
        'min-w-0 rounded border border-l-[3px] p-5',
        payment.mixed
          ? 'border-wait/25 border-l-wait bg-wait-soft'
          : 'border-line border-l-ink bg-card',
      )}
      aria-labelledby="payment-mode-title"
      data-testid="payment-mode-notice"
    >
      <div className="flex items-center gap-2">
        <IconShield size={18} className={payment.mixed ? 'text-wait' : 'text-ink'} />
        <h2 id="payment-mode-title" className="font-display text-base font-semibold">
          Способ оплаты
        </h2>
      </div>
      <div className="mt-3 space-y-2">
        {payment.sentences.map((sentence) => (
          <p key={sentence} className="text-sm text-ink/80">
            {sentence}
          </p>
        ))}
      </div>
      {payment.mixed && checkoutOpen ? (
        payment.offerSplit ? (
          <div className="mt-4 space-y-2">
            <a
              href="/checkout?part=local"
              className={cn(buttonClass({ variant: 'secondary', block: true }), 'bg-card')}
              data-testid="split-order"
            >
              {SPLIT_BUTTON_TEXT}
            </a>
            <p className="text-sm text-ink/80">{SPLIT_EXPLANATION}</p>
          </div>
        ) : (
          <a
            href="/checkout"
            className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4"
          >
            Оформить одним заказом
          </a>
        )
      ) : null}
    </section>
  );
}
