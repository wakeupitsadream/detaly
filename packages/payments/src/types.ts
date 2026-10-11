/**
 * Provider-neutral payment and receipt shapes. Amounts are integer kopecks everywhere; the
 * YooKassa adapter converts them to '1280.00' strings at the boundary.
 */
import type { PaymentMode, PaymentStatus, ReceiptStatus } from '@detaly/domain/statuses';
import type { Kop, ReceiptCustomer, ReceiptData, ReceiptLine } from '@detaly/domain/types';

// Receipt shapes moved to @detaly/domain in phase 1B (receipts are built there); this package
// re-exports them so its public API does not change.
export { PAYMENT_MODES, PAYMENT_SUBJECTS, RECEIPT_ITEM_MEASURE } from '@detaly/domain/statuses';
export type { PaymentMode, PaymentSubject, ReceiptItemMeasure } from '@detaly/domain/statuses';
export type { ReceiptCustomer, ReceiptData, ReceiptLine } from '@detaly/domain/types';

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

export type ConfirmationKind = 'redirect' | 'qr';

/**
 * Registration state of a receipt sent inside a payment or refund (`receipt_registration`).
 * VERIFY: field name and values (YooKassa API v3 reference, Ю1/Ю10); `null` when absent.
 */
export const RECEIPT_REGISTRATIONS = ['pending', 'succeeded', 'canceled'] as const;
export type ReceiptRegistration = (typeof RECEIPT_REGISTRATIONS)[number];

/** VERIFY Ю11: limits of `metadata` (16 keys, key 32 chars, value 512 chars). */
export const PAYMENT_METADATA_MAX_KEYS = 16;
export const PAYMENT_METADATA_KEY_MAX = 32;
export const PAYMENT_METADATA_VALUE_MAX = 512;
/** VERIFY Ю11: payment `description` is at most 128 characters. */
export const PAYMENT_DESCRIPTION_MAX = 128;

export interface CreatePaymentRequest {
  orderId: string;
  /** 'DT-000123', goes to the description shown to the client. */
  orderNumber: string;
  /** Always orders.total_kop. */
  amountKop: Kop;
  /** payments.idempotence_key; a new key only for an explicitly new payment. */
  idempotenceKey: string;
  /**
   * /o/<token>?paid=1 for redirect confirmation (required there). Ignored for `qr`: a QR payment
   * has no return_url.
   */
  returnUrl?: string;
  /** redirect (online link) by default; qr for payment at the pickup point. */
  confirmation?: ConfirmationKind;
  /** Receipt sent within the payment (prepayment or full). Omitted in plan B (own KKT). */
  receipt?: ReceiptData | null;
  /** Default 'Заказ DT-000123'; at most PAYMENT_DESCRIPTION_MAX characters. */
  description?: string;
  /**
   * Extra metadata (decision Б7: payment_row_id). order_id and order_number are always set by
   * the adapter and win over keys given here. Limits: PAYMENT_METADATA_* (VERIFY Ю11).
   */
  metadata?: Record<string, string>;
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
  /** Always RUB: any other currency is rejected as `bad_response`. */
  currency: 'RUB';
  /** Status of the receipt sent with the payment; null when the field is absent (VERIFY). */
  receiptRegistration: ReceiptRegistration | null;
  /** cancellation_details.reason for `canceled` (insufficient_funds, expired_on_confirmation…). */
  cancellationReason: string | null;
  /** cancellation_details.party (yoo_money, payment_network, merchant). */
  cancellationParty: string | null;
  /** captured_at of a succeeded payment (VERIFY: present with capture=true). */
  paidAt: string | null;
  /** refunded_amount, 0 when absent. */
  refundedAmountKop: Kop;
  /** Raw provider object for payments.raw. */
  raw: unknown;
}

/** Nightly reconciliation window (decision Б29): created_at in [createdGte, createdLt). */
export interface ListPaymentsRequest {
  /** ISO 8601 timestamp, inclusive. */
  createdGte: string;
  /** ISO 8601 timestamp, exclusive. */
  createdLt: string;
  /** next_cursor of the previous page. */
  cursor?: string | null;
  /** Page size, default 100 (VERIFY: maximum 100). */
  limit?: number;
}

export interface ProviderPaymentPage {
  items: ProviderPayment[];
  /** null on the last page. */
  nextCursor: string | null;
}

/**
 * The month reconciliation of /admin/month (step 7, docs/month-close.md): refunds created in
 * [createdGte, createdLt), the same window and paging as the payments list.
 */
export type ListRefundsRequest = ListPaymentsRequest;

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
  /** Status of the refund receipt sent in the refund body; null when absent (VERIFY Ю10). */
  receiptRegistration: ReceiptRegistration | null;
  /** cancellation_details.reason of a `canceled` refund. */
  cancellationReason: string | null;
  raw: unknown;
}

export interface ProviderRefundPage {
  items: ProviderRefund[];
  /** null on the last page. */
  nextCursor: string | null;
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
  /**
   * payment_mode shared by all items (full_prepayment for the prepayment receipt, full_payment
   * for full and offset receipts); null when items are absent or mixed.
   */
  paymentMode: PaymentMode | null;
  /** settlements[].type: 'prepayment' marks the offset receipt, 'cashless' a payment one. */
  settlementTypes: string[];
  /** registered_at when known (VERIFY). */
  registeredAt: string | null;
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
