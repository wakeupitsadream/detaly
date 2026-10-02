import type { PaymentScheme } from '@detaly/domain';
import { IconShield } from '@/components/icons';
import { FINAL_SCHEME_NOTE } from '@/server/cart/summary';
import { PAYMENT_SCHEME_TITLE } from './scheme-text';

export { PAYMENT_SCHEME_TITLE };

export { FINAL_SCHEME_NOTE };

/**
 * How the order will be paid, in words (explainPaymentScheme), on a graphite plate. Before the
 * phone is known no-shows count as 0, so under payment on handover the note says the server
 * decides finally; a prepayment (to-order parts, sum over the limit) does not depend on the
 * phone.
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
      className="grain-dark min-w-0 rounded border border-graphite-700 bg-graphite-900 p-5 text-steel-200 md:p-6"
      data-testid="payment-scheme"
      data-scheme={scheme}
    >
      <p className="text-label text-steel-400">Способ оплаты</p>
      <div className="mt-2 flex items-start gap-2.5">
        <IconShield size={22} className="mt-0.5 shrink-0 text-accent" />
        <h2 className="text-h3 text-paper">{PAYMENT_SCHEME_TITLE[scheme]}</h2>
      </div>
      <div className="mt-3 space-y-2">
        {sentences.map((sentence) => (
          <p key={sentence} className="text-sm">
            {sentence}
          </p>
        ))}
        {scheme === 'pay_on_handover' ? (
          <p className="text-sm text-steel-400">{FINAL_SCHEME_NOTE}</p>
        ) : null}
      </div>
    </section>
  );
}
