import type { PaymentScheme } from '@detaly/domain';
import { IconCard, IconCheck, IconChevronDown, IconWallet } from '@/components/icons';
import { FINAL_SCHEME_NOTE } from '@/server/cart/summary';
import { PAYMENT_METHOD_LINE, PAYMENT_SCHEME_TITLE } from './scheme-text';

export { PAYMENT_SCHEME_TITLE };

export { FINAL_SCHEME_NOTE };

/**
 * How the order will be paid, as the chosen card of the «Оплата» step: the anatomy of a checked
 * ChoiceCard — a bare icon, the scheme's name and the tick in the corner. The client does not pick it — the server decides by the cart and the phone —
 * so it is a card in the selected state, not a radio. How the money is paid stands visibly
 * under the name (PAYMENT_METHOD_LINE); the explanation (explainPaymentScheme)
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
      className="relative min-w-0 rounded-control border-[1.5px] border-brand bg-brand-soft"
      aria-labelledby="payment-scheme-title"
      data-testid="payment-scheme"
      data-scheme={scheme}
    >
      {/* The anatomy of a chosen ChoiceCard: a bare brand icon, the check in the top-right
          corner 10 px clear of the frame. */}
      <span
        aria-hidden
        className="absolute top-2.5 right-2.5 grid size-6 place-items-center rounded-full bg-brand text-on-brand"
      >
        <IconCheck size={16} strokeWidth={2.5} />
      </span>
      <div className="flex min-w-0 items-start gap-3 pt-4 pr-11 pb-2 pl-4">
        <Icon size={28} className="mt-0.5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <h3 id="payment-scheme-title" className="text-h3">
            {PAYMENT_SCHEME_TITLE[scheme]}
          </h3>
          {/* Visible, not under the disclosure: how to pay (no cash at the point). */}
          <p className="mt-0.5 text-small font-normal text-muted" data-testid="payment-method">
            {PAYMENT_METHOD_LINE[scheme]}
          </p>
        </div>
      </div>
      <details className="details-plain group px-4 pb-3">
        {/* A disclosure, not a page link: ink with a quiet underline, like every «Как это
            работает» and «Подробнее» on the site (page links inside text are brand). */}
        <summary className="inline-flex min-h-11 items-center gap-1.5 text-small font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
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
