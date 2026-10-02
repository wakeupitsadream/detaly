import type { PaymentScheme } from '@detaly/domain';

/** Headline of a payment scheme on /checkout (summary card and the 409 notice in the form). */
export const PAYMENT_SCHEME_TITLE: Record<PaymentScheme, string> = {
  pay_on_handover: 'Оплата при получении',
  prepay: 'Предоплата 100% онлайн',
};
