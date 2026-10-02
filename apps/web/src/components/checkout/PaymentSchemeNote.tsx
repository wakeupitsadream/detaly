import type { PaymentScheme } from '@detaly/domain';

export const PAYMENT_SCHEME_TITLE: Record<PaymentScheme, string> = {
  pay_on_handover: 'Оплата при получении',
  prepay: 'Предоплата 100% онлайн',
};

export const FINAL_SCHEME_NOTE = 'Окончательно способ оплаты определим по номеру телефона.';

/**
 * How the order will be paid, in words (explainPaymentScheme). Before the phone is known
 * no-shows count as 0, so the note says the server decides finally.
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
      <p className="text-xs text-muted">{FINAL_SCHEME_NOTE}</p>
    </section>
  );
}
