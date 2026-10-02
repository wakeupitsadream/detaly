/**
 * YooKassa API v3 adapter over fetch (Basic auth shopId:secretKey, Idempotence-Key on POST).
 *
 * Status: written from the public API reference and exercised only against the msw emulation
 * in ./testing. Field formats marked "to verify" in docs/PLAN.md section 4 (vat_code,
 * tax_system_code, phone format, qr confirmation, refund receipt) must be checked on the
 * YooKassa test shop before production use.
 */
import { isOneOf, PAYMENT_STATUSES, RECEIPT_STATUSES } from '@detaly/domain/statuses';
import { amountValueToKop, kopToAmountValue } from './amount';
import { PaymentProviderError, type PaymentProvider, WebhookParseError } from './payment-provider';
import type { ReceiptProvider } from './receipt-provider';
import { assertReceiptLines } from './receipt-lines';
import {
  type CreateOffsetReceiptRequest,
  type CreatePaymentRequest,
  type CreateRefundRequest,
  PROVIDER_REFUND_STATUSES,
  type ProviderPayment,
  type ProviderReceipt,
  type ProviderRefund,
  type ReceiptData,
  type ReceiptLine,
  WEBHOOK_EVENTS,
  type WebhookNotification,
} from './types';

export const YOOKASSA_DEFAULT_API_URL = 'https://api.yookassa.ru/v3';

export interface YooKassaOptions {
  shopId: string;
  secretKey: string;
  /** YOOKASSA_API_URL, default https://api.yookassa.ru/v3. */
  apiUrl?: string;
  /** Request timeout, default 15 s. */
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function money(kop: number): { value: string; currency: 'RUB' } {
  return { value: kopToAmountValue(kop), currency: 'RUB' };
}

function receiptLinesPayload(lines: readonly ReceiptLine[]): Json[] {
  return lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    amount: money(line.unitPriceKop),
    vat_code: line.vatCode,
    payment_subject: line.paymentSubject,
    payment_mode: line.paymentMode,
  }));
}

function receiptPayload(receipt: ReceiptData): Json {
  const customer: Json = {};
  if (receipt.customer.phone !== undefined) customer.phone = receipt.customer.phone;
  if (receipt.customer.email !== undefined) customer.email = receipt.customer.email;
  const payload: Json = { customer, items: receiptLinesPayload(receipt.lines) };
  if (receipt.taxSystemCode !== undefined) payload.tax_system_code = receipt.taxSystemCode;
  return payload;
}

function parseAmount(raw: unknown, what: string): number {
  if (!isRecord(raw) || typeof raw.value !== 'string' || raw.currency !== 'RUB') {
    throw new PaymentProviderError(`unexpected ${what} amount`, {
      status: null,
      code: 'bad_response',
      retryable: false,
    });
  }
  return amountValueToKop(raw.value);
}

function badResponse(what: string): PaymentProviderError {
  return new PaymentProviderError(`unexpected ${what} response`, {
    status: null,
    code: 'bad_response',
    retryable: false,
  });
}

export function parsePayment(raw: unknown): ProviderPayment {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !isOneOf(PAYMENT_STATUSES, raw.status)) {
    throw badResponse('payment');
  }
  const confirmation = isRecord(raw.confirmation) ? raw.confirmation : {};
  const metadata: Record<string, string> = {};
  if (isRecord(raw.metadata)) {
    for (const [k, v] of Object.entries(raw.metadata)) if (typeof v === 'string') metadata[k] = v;
  }
  const method = isRecord(raw.payment_method) ? str(raw.payment_method.type) : null;
  return {
    id: raw.id,
    status: raw.status,
    paid: raw.paid === true,
    amountKop: parseAmount(raw.amount, 'payment'),
    confirmationUrl: str(confirmation.confirmation_url),
    confirmationData: str(confirmation.confirmation_data),
    createdAt: str(raw.created_at) ?? '',
    expiresAt: str(raw.expires_at),
    method,
    metadata,
    test: raw.test === true,
    raw,
  };
}

export function parseRefund(raw: unknown): ProviderRefund {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    typeof raw.payment_id !== 'string' ||
    !isOneOf(PROVIDER_REFUND_STATUSES, raw.status)
  ) {
    throw badResponse('refund');
  }
  return {
    id: raw.id,
    paymentId: raw.payment_id,
    status: raw.status,
    amountKop: parseAmount(raw.amount, 'refund'),
    createdAt: str(raw.created_at) ?? '',
    raw,
  };
}

export function parseReceipt(raw: unknown): ProviderReceipt {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    (raw.type !== 'payment' && raw.type !== 'refund') ||
    !isOneOf(RECEIPT_STATUSES, raw.status)
  ) {
    throw badResponse('receipt');
  }
  return {
    id: raw.id,
    type: raw.type,
    status: raw.status,
    paymentId: str(raw.payment_id),
    refundId: str(raw.refund_id),
    fiscalDocumentNumber: str(raw.fiscal_document_number),
    raw,
  };
}

/** Validates a notification body: {type: 'notification', event, object: {id, status}}. */
export function parseYooKassaWebhook(body: unknown): WebhookNotification {
  if (!isRecord(body) || body.type !== 'notification') {
    throw new WebhookParseError('not a YooKassa notification');
  }
  if (!isOneOf(WEBHOOK_EVENTS, body.event)) {
    throw new WebhookParseError(`unsupported event ${String(body.event)}`);
  }
  const object = body.object;
  if (!isRecord(object) || typeof object.id !== 'string' || object.id === '') {
    throw new WebhookParseError('notification object has no id');
  }
  return {
    event: body.event,
    objectType: body.event.startsWith('refund.') ? 'refund' : 'payment',
    objectId: object.id,
    objectStatus: str(object.status),
    raw: body,
  };
}

export function createYooKassaProvider(
  options: YooKassaOptions,
): PaymentProvider & ReceiptProvider {
  const apiUrl = (options.apiUrl ?? YOOKASSA_DEFAULT_API_URL).replace(/\/+$/u, '');
  const timeoutMs = options.timeoutMs ?? 15_000;
  // Resolved per call so instrumentation that patches globalThis.fetch (msw) is honoured.
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const authorization = `Basic ${Buffer.from(`${options.shopId}:${options.secretKey}`).toString('base64')}`;

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: Json,
    idempotenceKey?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: authorization };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotenceKey !== undefined) headers['Idempotence-Key'] = idempotenceKey;
    let response: Response;
    try {
      response = await doFetch(`${apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Network error or timeout: the request may have reached YooKassa; retry with the same key.
      throw new PaymentProviderError(
        `YooKassa ${method} ${path} failed: ${(error as Error).name}`,
        {
          status: null,
          code: 'network',
          retryable: true,
        },
      );
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (response.status === 202) {
      // YooKassa has not finished the request yet ({type: 'processing', retry_after}): the
      // operation must be repeated later with the same Idempotence-Key.
      const body = isRecord(json) ? json : {};
      const retryAfterMs = typeof body.retry_after === 'number' ? body.retry_after : null;
      throw new PaymentProviderError(`YooKassa ${method} ${path}: still processing`, {
        status: 202,
        code: 'processing',
        retryable: true,
        retryAfterMs,
      });
    }
    if (!response.ok) {
      const err = isRecord(json) ? json : {};
      throw new PaymentProviderError(
        `YooKassa ${method} ${path}: HTTP ${response.status} ${str(err.code) ?? ''}`.trim(),
        {
          status: response.status,
          code: str(err.code),
          retryable: response.status === 429 || response.status >= 500,
          requestId: str(err.id),
        },
      );
    }
    return json;
  }

  return {
    name: 'yookassa',

    async createPayment(request: CreatePaymentRequest): Promise<ProviderPayment> {
      const confirmation =
        request.confirmation === 'qr'
          ? { type: 'qr' }
          : { type: 'redirect', return_url: request.returnUrl };
      const payload: Json = {
        amount: money(request.amountKop),
        capture: true,
        confirmation,
        description: `Заказ ${request.orderNumber}`,
        metadata: { order_id: request.orderId, order_number: request.orderNumber },
      };
      if (request.receipt) {
        const mode = request.receipt.lines[0]?.paymentMode ?? 'full_prepayment';
        assertReceiptLines(request.receipt.lines, {
          totalKop: request.amountKop,
          paymentMode: mode,
        });
        payload.receipt = receiptPayload(request.receipt);
      }
      return parsePayment(await call('POST', '/payments', payload, request.idempotenceKey));
    },

    async getPayment(id: string): Promise<ProviderPayment> {
      return parsePayment(await call('GET', `/payments/${encodeURIComponent(id)}`));
    },

    async createRefund(request: CreateRefundRequest): Promise<ProviderRefund> {
      const payload: Json = { payment_id: request.paymentId, amount: money(request.amountKop) };
      if (request.description !== undefined) payload.description = request.description;
      if (request.receipt) {
        const mode = request.receipt.lines[0]?.paymentMode ?? 'full_prepayment';
        assertReceiptLines(request.receipt.lines, {
          totalKop: request.amountKop,
          paymentMode: mode,
        });
        payload.receipt = receiptPayload(request.receipt);
      }
      return parseRefund(await call('POST', '/refunds', payload, request.idempotenceKey));
    },

    async getRefund(id: string): Promise<ProviderRefund> {
      return parseRefund(await call('GET', `/refunds/${encodeURIComponent(id)}`));
    },

    parseWebhook: parseYooKassaWebhook,

    async createOffsetReceipt(request: CreateOffsetReceiptRequest): Promise<ProviderReceipt> {
      assertReceiptLines(request.lines, {
        totalKop: request.prepaymentKop,
        paymentMode: 'full_payment',
      });
      const payload: Json = {
        type: 'payment',
        payment_id: request.paymentId,
        send: true,
        ...receiptPayload({
          customer: request.customer,
          lines: request.lines,
          ...(request.taxSystemCode === undefined ? {} : { taxSystemCode: request.taxSystemCode }),
        }),
        settlements: [{ type: 'prepayment', amount: money(request.prepaymentKop) }],
      };
      return parseReceipt(await call('POST', '/receipts', payload, request.idempotenceKey));
    },

    async getReceipt(id: string): Promise<ProviderReceipt> {
      return parseReceipt(await call('GET', `/receipts/${encodeURIComponent(id)}`));
    },
  };
}
