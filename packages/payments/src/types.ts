/**
 * Provider-neutral payment and receipt shapes. Amounts are integer kopecks everywhere; the
 * YooKassa adapter converts them to '1280.00' strings at the boundary.
 */
import type { PaymentStatus, ReceiptStatus } from '@detaly/domain/statuses';
import type { Kop } from '@detaly/domain/types';

/** 54-FZ settlement method of a receipt line ("признак способа расчёта"). */
export const PAYMENT_MODES = ['full_prepayment', 'full_payment'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** Subject of a receipt line. Installation is never sold, so only goods and delivery exist. */
export const PAYMENT_SUBJECTS = ['commodity', 'service'] as const;
export type PaymentSubject = (typeof PAYMENT_SUBJECTS)[number];

export interface ReceiptCustomer {
  /** E.164 without '+' as YooKassa expects ('79991234567'); format to verify with YooKassa. */
  phone?: string;
  email?: string;
}

export interface ReceiptLine {
  /** 'Бренд Артикул Название', at most 128 characters. */
  description: string;
  /** Whole units; parts are never sold by weight. */
  quantity: number;
  /** Price per unit. */
  unitPriceKop: Kop;
  /** YooKassa vat_code (YOOKASSA_VAT_CODE, "без НДС" - to verify). */
  vatCode: number;
  paymentSubject: PaymentSubject;
  paymentMode: PaymentMode;
}

export interface ReceiptData {
  customer: ReceiptCustomer;
  lines: ReceiptLine[];
  /** YooKassa tax_system_code (YOOKASSA_TAX_SYSTEM_CODE, "УСН доход" - to verify). */
  taxSystemCode?: number;
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

export type ConfirmationKind = 'redirect' | 'qr';

export interface CreatePaymentRequest {
  orderId: string;
  /** 'DT-000123', goes to the description shown to the client. */
  orderNumber: string;
  /** Always orders.total_kop. */
  amountKop: Kop;
  /** payments.idempotence_key; a new key only for an explicitly new payment. */
  idempotenceKey: string;
  /** /o/<token> for redirect confirmation. */
  returnUrl: string;
  /** redirect (online link) by default; qr for payment at the pickup point. */
  confirmation?: ConfirmationKind;
  /** Receipt sent within the payment (prepayment or full). Omitted in plan B (own KKT). */
  receipt?: ReceiptData | null;
}

export interface ProviderPayment {
  id: string;
  status: PaymentStatus;
  paid: boolean;
  amountKop: Kop;
  /** Redirect URL for confirmation type redirect. */
  confirmationUrl: string | null;
  /** QR payload for confirmation type qr. */
  confirmationData: string | null;
  createdAt: string;
  expiresAt: string | null;
  /** payment_method.type when known (bank_card, sbp, ...). */
  method: string | null;
  metadata: Record<string, string>;
  test: boolean;
  /** Raw provider object for payments.raw. */
  raw: unknown;
}

// ---------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------

/** YooKassa refund statuses; `canceled` maps to refunds.status = 'failed' (alert). */
export const PROVIDER_REFUND_STATUSES = ['pending', 'succeeded', 'canceled'] as const;
export type ProviderRefundStatus = (typeof PROVIDER_REFUND_STATUSES)[number];

export interface CreateRefundRequest {
  paymentId: string;
  amountKop: Kop;
  /** refunds.idempotence_key */
  idempotenceKey: string;
  description?: string;
  /** Refund receipt: returned lines with the payment_mode of the original receipt. */
  receipt?: ReceiptData | null;
}

export interface ProviderRefund {
  id: string;
  paymentId: string;
  status: ProviderRefundStatus;
  amountKop: Kop;
  createdAt: string;
  raw: unknown;
}

// ---------------------------------------------------------------------------------------------
// Receipts (separate provider: YooKassa receipts or a cloud KKT in plan B)
// ---------------------------------------------------------------------------------------------

/** Final settlement with prepayment offset, issued at handover ("Клиент пришёл"). */
export interface CreateOffsetReceiptRequest {
  paymentId: string;
  /** receipts.idempotence_key; retried with the same key until succeeded. */
  idempotenceKey: string;
  customer: ReceiptCustomer;
  /** Lines actually handed over, payment_mode full_payment. */
  lines: ReceiptLine[];
  /** Prepayment being offset; must equal the sum of lines. */
  prepaymentKop: Kop;
  taxSystemCode?: number;
}

export interface ProviderReceipt {
  id: string;
  type: 'payment' | 'refund';
  status: ReceiptStatus;
  paymentId: string | null;
  refundId: string | null;
  fiscalDocumentNumber: string | null;
  raw: unknown;
}

/** Placeholder until the provider confirms correction receipts are available. */
export interface CreateCorrectionReceiptRequest {
  idempotenceKey: string;
  paymentId: string;
  reason: string;
  lines: ReceiptLine[];
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

export const WEBHOOK_EVENTS = [
  'payment.succeeded',
  'payment.waiting_for_capture',
  'payment.canceled',
  'refund.succeeded',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * A parsed notification. It is only a hint: the worker re-reads the object by id and trusts
 * that answer (PLAN section 4).
 */
export interface WebhookNotification {
  event: WebhookEvent;
  objectType: 'payment' | 'refund';
  objectId: string;
  objectStatus: string | null;
  raw: unknown;
}
