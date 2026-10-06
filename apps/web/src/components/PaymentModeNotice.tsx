import { FINAL_SCHEME_NOTE, type PaymentNotice } from '@/server/cart/summary';
import { IconChevronDown, IconShield, IconWallet } from './icons';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';

export const SPLIT_BUTTON_TEXT = 'Разделить на два заказа';
export const SPLIT_EXPLANATION =
  'Сначала оформим детали из Оренбурга с оплатой при получении, затем — под заказ.';

/** «Одним заказом — предоплата 100%»: the headline of a mixed cart. */
const MIXED_HEADLINE = 'Одним заказом — предоплата 100%';

/** The one line of the notice: what the client pays and when. */
function headline(payment: PaymentNotice): string {
  if (payment.mixed) return MIXED_HEADLINE;
  // summarizeCart adds the phone note under payment on handover only.
  return payment.sentences.includes(FINAL_SCHEME_NOTE)
    ? 'Оплата при получении'
    : 'Предоплата 100% онлайн';
}

/**
 * How the cart will be paid (docs/phase-1a-implementation.md section 5.2), as one line with an
 * icon and the details under a disclosure (docs/design-v2.md, «Корзина»). For a mixed cart the
 * prepayment headline and, when the Orenburg part alone qualifies for payment on handover,
 * "Разделить на два заказа" (/checkout?part=local). Links are plain anchors: /checkout
 * re-prices on render.
 */
export function PaymentModeNotice({
  payment,
  checkoutOpen,
  hasToOrder = false,
}: {
  payment: PaymentNotice;
  /** Some lines are to order (prepaid): say how the money is paid and protected. */
  hasToOrder?: boolean;
  /** Checkout gate open and the order minimums met; otherwise no checkout links. */
  checkoutOpen: boolean;
}) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-tile border p-1',
        payment.mixed ? 'border-wait-soft bg-wait-soft' : 'border-line bg-bg',
      )}
      aria-labelledby="payment-mode-title"
      data-testid="payment-mode-notice"
    >
      <details className="details-plain group">
        <summary className="flex min-h-12 items-center gap-3 rounded-[16px] px-3 py-2 hover:bg-bg/60">
          <IconWallet
            size={24}
            className={cn('shrink-0', payment.mixed ? 'text-wait' : 'text-brand')}
          />
          <h2 id="payment-mode-title" className="min-w-0 flex-1 text-body font-bold">
            {headline(payment)}
          </h2>
          <span className="sr-only">Подробнее</span>
          <IconChevronDown
            size={22}
            className="shrink-0 text-muted transition-transform duration-150 group-open:rotate-180"
          />
        </summary>
        <div className="space-y-2 px-3 pt-1 pb-3 text-small font-normal">
          {payment.sentences.map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
          {hasToOrder ? (
            <p className="flex items-start gap-2">
              <IconShield size={20} className="mt-px shrink-0 text-ok" />
              <span className="min-w-0">
                Под заказ — предоплата картой или СБП через ЮKassa, чек придёт на телефон. Если
                поставщик подведёт — вернём деньги полностью, без удержаний.
              </span>
            </p>
          ) : null}
        </div>
      </details>
      {payment.mixed && checkoutOpen ? (
        payment.offerSplit ? (
          <div className="space-y-2 px-3 pt-1 pb-3">
            <a
              href="/checkout?part=local"
              className={buttonClass({ variant: 'secondary', block: true })}
              data-testid="split-order"
            >
              {SPLIT_BUTTON_TEXT}
            </a>
            <p className="text-small font-normal">{SPLIT_EXPLANATION}</p>
          </div>
        ) : (
          <div className="px-3 pb-2">
            <a href="/checkout" className={buttonClass({ variant: 'ghost' })}>
              Оформить одним заказом
            </a>
          </div>
        )
      ) : null}
    </section>
  );
}
