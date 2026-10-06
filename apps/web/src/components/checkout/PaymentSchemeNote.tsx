import type { PaymentScheme } from '@detaly/domain';
import { IconCard, IconCheck, IconChevronDown, IconWallet } from '@/components/icons';
import { FINAL_SCHEME_NOTE } from '@/server/cart/summary';
import { PAYMENT_SCHEME_TITLE } from './scheme-text';

export { PAYMENT_SCHEME_TITLE };

export { FINAL_SCHEME_NOTE };

/**
 * How the order will be paid, as the chosen card of the «Оплата» step: an icon, the scheme's
 * name and a tick. The client does not pick it — the server decides by the cart and the phone —
 * so it is a card in the selected state, not a radio. The explanation (explainPaymentScheme)
 * is under a disclosure. Before the phone is known no-shows count as 0, so under payment on
 * handover the note says the server decides finally; a prepayment does not depend on the phone.
 */
export function PaymentSchemeNote({
  scheme,
  sentences,
}: {
  scheme: PaymentScheme;
  sentences: readonly string[];
}) {
  const Icon = scheme === 'prepay' ? IconCard : IconWallet;
  return (
    <section
      className="min-w-0 rounded-tile border-2 border-brand bg-brand-soft/40"
      aria-labelledby="payment-scheme-title"
      data-testid="payment-scheme"
      data-scheme={scheme}
    >
      <div className="flex min-w-0 items-center gap-3 px-4 pt-4 pb-2">
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-bg text-brand">
          <Icon size={26} />
        </span>
        <h3 id="payment-scheme-title" className="min-w-0 flex-1 text-h3">
          {PAYMENT_SCHEME_TITLE[scheme]}
        </h3>
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-full bg-brand text-on-brand"
        >
          <IconCheck size={18} strokeWidth={2.5} />
        </span>
      </div>
      <details className="details-plain group px-4 pb-3">
        <summary className="inline-flex min-h-11 items-center gap-1.5 text-small font-semibold text-brand">
          Как это работает
          <IconChevronDown
            size={20}
            className="transition-transform duration-150 group-open:rotate-180"
          />
        </summary>
        <div className="space-y-2 pb-1 text-small font-normal">
          {sentences.map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
          {scheme === 'pay_on_handover' ? <p className="text-muted">{FINAL_SCHEME_NOTE}</p> : null}
        </div>
      </details>
    </section>
  );
}
