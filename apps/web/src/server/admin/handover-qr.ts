/**
 * The QR block of the card at awaiting_handover_payment: the order's current payment when it
 * is a pending QR payment with its payload (payments.confirmation_data, decision Б28).
 */
import { qrSvgDataUri } from './qr';
import type { AdminOrderCard } from './queries';

export interface AdminQr {
  /** SVG data URI of the QR payload. */
  dataUri: string;
  amountKop: number;
  expiresAt: Date | null;
}

export async function handoverQr(card: AdminOrderCard): Promise<AdminQr | null> {
  if (card.order.status !== 'awaiting_handover_payment') return null;
  const payment = card.payments.at(-1);
  if (!payment || payment.status !== 'pending' || payment.confirmationType !== 'qr') return null;
  const data = payment.confirmationData;
  if (!data) return null;
  return {
    dataUri: await qrSvgDataUri(data),
    amountKop: payment.amountKop,
    expiresAt: payment.expiresAt ?? card.order.expiresAt,
  };
}
