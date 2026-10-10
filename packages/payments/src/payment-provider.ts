/**
 * Payment provider contract (PLAN decision 9). The first implementation is YooKassa; the
 * worker and web depend on this interface only.
 */
import type {
  CreatePaymentRequest,
  CreateRefundRequest,
  ListPaymentsRequest,
  ListRefundsRequest,
  ProviderPayment,
  ProviderPaymentPage,
  ProviderRefund,
  ProviderRefundPage,
  WebhookNotification,
} from './types';

export interface PaymentProvider {
  readonly name: 'yookassa';
  /** POST /payments with Idempotence-Key = request.idempotenceKey, capture=true. */
  createPayment(request: CreatePaymentRequest): Promise<ProviderPayment>;
  /** GET /payments/{id}: the only source of truth for webhooks and reconciliation. */
  getPayment(id: string): Promise<ProviderPayment>;
  /** POST /refunds with Idempotence-Key; partial refunds by line are allowed. */
  createRefund(request: CreateRefundRequest): Promise<ProviderRefund>;
  getRefund(id: string): Promise<ProviderRefund>;
  /**
   * One page of the shop's payments created in [createdGte, createdLt) for the nightly
   * reconciliation (decision Б29). VERIFY: GET /payments list format and filters.
   */
  listPayments(request: ListPaymentsRequest): Promise<ProviderPaymentPage>;
  /**
   * One page of the shop's refunds created in [createdGte, createdLt) for the month
   * reconciliation of /admin/month (step 7). VERIFY: GET /refunds list format and filters.
   */
  listRefunds(request: ListRefundsRequest): Promise<ProviderRefundPage>;
  /** Parses a notification body; throws WebhookParseError on anything unexpected. */
  parseWebhook(body: unknown): WebhookNotification;
}

/** Error from a provider call. `retryable` drives BullMQ retries. */
export class PaymentProviderError extends Error {
  override name = 'PaymentProviderError';
  constructor(
    message: string,
    readonly details: {
      status: number | null;
      code: string | null;
      retryable: boolean;
      requestId?: string | null;
      /** HTTP 202 `processing`: repeat after this delay with the same Idempotence-Key. */
      retryAfterMs?: number | null;
    },
  ) {
    super(message);
  }
}

/**
 * A request rejected locally before any network call (description or metadata over the
 * provider limits, redirect without return_url). A programming or configuration error: never
 * retried, like ReceiptLinesError.
 */
export class PaymentRequestError extends RangeError {
  override name = 'PaymentRequestError';
}

export class WebhookParseError extends Error {
  override name = 'WebhookParseError';
}

/** BullMQ jobId for a notification: YooKassa notifications have no event id (PLAN section 1). */
export function webhookJobId(
  notification: Pick<WebhookNotification, 'event' | 'objectId'>,
): string {
  return `${notification.event}:${notification.objectId}`;
}
