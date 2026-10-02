import type { PaymentScheme } from '@detaly/domain';
import { FINAL_SCHEME_NOTE } from '@/server/cart/summary';
import { PAYMENT_SCHEME_TITLE } from './scheme-text';

export { PAYMENT_SCHEME_TITLE };

export { FINAL_SCHEME_NOTE };

/**
 * How the order will be paid, in words (explainPaymentScheme). Before the phone is known
 * no-shows count as 0, so under payment on handover the note says the server decides finally;
 * a prepayment (to-order parts, sum over the limit) does not depend on the phone.
 */
export function PaymentSchemeNote({
  scheme,
  sentences,
}: {
  scheme: PaymentScheme;
  sentences: readonly string[];
}) {
  return (
    <section
      className="space-y-2 rounded-card border border-line bg-card p-4"
      data-testid="payment-scheme"
      data-scheme={scheme}
    >
      <h2 className="font-semibold">{PAYMENT_SCHEME_TITLE[scheme]}</h2>
      {sentences.map((sentence) => (
        <p key={sentence} className="text-sm text-muted">
          {sentence}
        </p>
      ))}
      {scheme === 'pay_on_handover' ? (
        <p className="text-xs text-muted">{FINAL_SCHEME_NOTE}</p>
      ) : null}
    </section>
  );
}
