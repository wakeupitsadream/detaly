import type { PaymentScheme } from '@detaly/domain';

/** Headline of a payment scheme on /checkout (summary card and the 409 notice in the form). */
export const PAYMENT_SCHEME_TITLE: Record<PaymentScheme, string> = {
  pay_on_handover: 'Оплата при получении',
  prepay: 'Предоплата 100% онлайн',
};

/**
 * How the money is paid, one visible line under the scheme (offer 3.3-3.4): a buyer who reads
 * only «Оплата при получении» might come with cash, which the point does not take.
 */
export const PAYMENT_METHOD_LINE: Record<PaymentScheme, string> = {
  pay_on_handover: 'Картой или по QR. Наличные не принимаем.',
  prepay: 'Картой или СБП сразу при оформлении.',
};
