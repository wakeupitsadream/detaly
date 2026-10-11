/**
 * YooKassa API v3 adapter over fetch (Basic auth shopId:secretKey, Idempotence-Key on POST).
 *
 * Status: written from the public API reference and exercised only against the msw emulation
 * in ./testing. Field formats marked "to verify" in docs/PLAN.md section 4 (vat_code,
 * tax_system_code, phone format, qr confirmation, refund receipt) must be checked on the
 * YooKassa test shop before production use; every unconfirmed field below carries a VERIFY:
 * comment (docs/external.md, Ю1, Ю4, Ю5, Ю9–Ю11).
 *
 * Parsers are strict about what the money logic needs (id, status, amount in RUB) and lenient
 * about the rest: an absent optional field becomes null instead of an error, so a difference
 * between the real API and the emulation degrades to "unknown" (for example receipt status
 * unknown -> "Выдал" stays blocked) rather than a crash.
 */
import {
  isOneOf,
  PAYMENT_MODES,
  PAYMENT_STATUSES,
  type PaymentMode,
  RECEIPT_STATUSES,
} from '@detaly/domain/statuses';
import { AmountFormatError, amountValueToKop, kopToAmountValue } from './amount';
import {
  PaymentProviderError,
  PaymentRequestError,
  type PaymentProvider,
  WebhookParseError,
} from './payment-provider';
import type { ReceiptProvider } from './receipt-provider';
import { assertReceiptLines } from './receipt-lines';
import {
  type CreateOffsetReceiptRequest,
  type CreatePaymentRequest,
  type CreateRefundRequest,
  type ListPaymentsRequest,
  type ListRefundsRequest,
  PAYMENT_DESCRIPTION_MAX,
  PAYMENT_METADATA_KEY_MAX,
  PAYMENT_METADATA_MAX_KEYS,
  PAYMENT_METADATA_VALUE_MAX,
  PROVIDER_REFUND_STATUSES,
  type ProviderPayment,
  type ProviderPaymentPage,
  type ProviderReceipt,
  type ProviderRefund,
  type ProviderRefundPage,
  type ReceiptData,
  type ReceiptLine,
  RECEIPT_REGISTRATIONS,
  type ReceiptRegistration,
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
    // VERIFY Ю11: item description at most 128 characters.
    description: line.description,
    quantity: line.quantity,
    // FFD 1.2 tag 2108, the measure of `quantity`: 'piece' on every line (RECEIPT_ITEM_MEASURE).
    measure: line.measure,
    // `amount` of an item is the price of one unit.
    amount: money(line.unitPriceKop),
    // VERIFY Ю4: vat_code of "без НДС" (YOOKASSA_VAT_CODE, 1 expected).
    vat_code: line.vatCode,
    payment_subject: line.paymentSubject,
    payment_mode: line.paymentMode,
  }));
}

function receiptPayload(receipt: ReceiptData): Json {
  const customer: Json = {};
  // VERIFY Ю11: customer.phone as digits without '+' ('79991234567').
  if (receipt.customer.phone !== undefined) customer.phone = receipt.customer.phone;
  if (receipt.customer.email !== undefined) customer.email = receipt.customer.email;
  const payload: Json = { customer, items: receiptLinesPayload(receipt.lines) };
  // VERIFY Ю4: tax_system_code of "УСН доходы" (YOOKASSA_TAX_SYSTEM_CODE, 2 expected).
  if (receipt.taxSystemCode !== undefined) payload.tax_system_code = receipt.taxSystemCode;
  return payload;
}

/** Only RUB is accepted: a payment in another currency is a provider or configuration error. */
function parseAmount(raw: unknown, what: string): number {
  if (!isRecord(raw) || typeof raw.value !== 'string' || raw.currency !== 'RUB') {
    throw new PaymentProviderError(`unexpected ${what} amount`, {
      status: null,
      code: 'bad_response',
      retryable: false,
    });
  }
  try {
    return amountValueToKop(raw.value);
  } catch (error) {
    // '-1.00', '1.005' or garbage from the provider: a bad response, not a programming error.
    if (error instanceof AmountFormatError) throw badResponse(`${what} amount`);
    throw error;
  }
}

function badResponse(what: string): PaymentProviderError {
  return new PaymentProviderError(`unexpected ${what} response`, {
    status: null,
    code: 'bad_response',
    retryable: false,
  });
}

function receiptRegistration(raw: unknown): ReceiptRegistration | null {
  // VERIFY Ю1/Ю10: `receipt_registration` on payment and refund objects with values
  // pending | succeeded | canceled; absent when no receipt was sent.
  return isOneOf(RECEIPT_REGISTRATIONS, raw) ? raw : null;
}

function cancellation(raw: Json): { reason: string | null; party: string | null } {
  // cancellation_details {party, reason} of canceled payments and refunds.
  const details = isRecord(raw.cancellation_details) ? raw.cancellation_details : {};
  return { reason: str(details.reason), party: str(details.party) };
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
  const { reason, party } = cancellation(raw);
  return {
    id: raw.id,
    status: raw.status,
    paid: raw.paid === true,
    amountKop: parseAmount(raw.amount, 'payment'),
    confirmationUrl: str(confirmation.confirmation_url),
    // VERIFY Ю9: confirmation {type: 'qr', confirmation_data} carries the SBP QR payload.
    confirmationData: str(confirmation.confirmation_data),
    createdAt: str(raw.created_at) ?? '',
    expiresAt: str(raw.expires_at),
    method,
    metadata,
    test: raw.test === true,
    currency: 'RUB',
    receiptRegistration: receiptRegistration(raw.receipt_registration),
    cancellationReason: reason,
    cancellationParty: party,
    // VERIFY: captured_at is set for succeeded payments created with capture=true.
    paidAt: raw.status === 'succeeded' ? str(raw.captured_at) : null,
    refundedAmountKop:
      raw.refunded_amount === undefined ? 0 : parseAmount(raw.refunded_amount, 'refunded'),
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
    receiptRegistration: receiptRegistration(raw.receipt_registration),
    cancellationReason: cancellation(raw).reason,
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
    paymentMode: receiptPaymentMode(raw.items),
    // VERIFY Ю1: settlements[].type of a receipt sent inside a payment ('cashless') and of the
    // offset receipt ('prepayment') as returned by GET /receipts.
    settlementTypes: Array.isArray(raw.settlements)
      ? raw.settlements.flatMap((s) => (isRecord(s) && typeof s.type === 'string' ? [s.type] : []))
      : [],
    // VERIFY: registered_at of a succeeded receipt.
    registeredAt: str(raw.registered_at),
    raw,
  };
}

function receiptPaymentMode(items: unknown): PaymentMode | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const modes = new Set(items.map((item) => (isRecord(item) ? item.payment_mode : null)));
  const [mode] = modes;
  return modes.size === 1 && isOneOf(PAYMENT_MODES, mode) ? mode : null;
}

/**
 * List envelope {type: 'list', items: [...], next_cursor?}. VERIFY: list format of GET /payments,
 * GET /refunds and GET /receipts (type 'list', next_cursor absent on the last page).
 */
function parseList(raw: unknown, what: string): { items: unknown[]; nextCursor: string | null } {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.items) ||
    (raw.type !== undefined && raw.type !== 'list')
  ) {
    throw badResponse(`${what} list`);
  }
  const nextCursor = str(raw.next_cursor);
  return { items: raw.items, nextCursor: nextCursor === '' ? null : nextCursor };
}

/** Hard stop for cursor loops: a receipt list longer than this is a provider bug. */
const MAX_LIST_PAGES = 20;
/** VERIFY: page size limit of YooKassa lists (documented maximum 100). */
const LIST_LIMIT_MAX = 100;

function assertPaymentRequest(request: CreatePaymentRequest): void {
  if (
    request.description !== undefined &&
    (request.description.trim() === '' || request.description.length > PAYMENT_DESCRIPTION_MAX)
  ) {
    throw new PaymentRequestError(
      `payment description must be 1..${PAYMENT_DESCRIPTION_MAX} characters`,
    );
  }
  if (request.confirmation !== 'qr' && (request.returnUrl ?? '') === '') {
    throw new PaymentRequestError('redirect confirmation requires returnUrl');
  }
}

/** order_id and order_number always win over request.metadata; limits are VERIFY Ю11. */
function paymentMetadata(request: CreatePaymentRequest): Record<string, string> {
  const metadata: Record<string, string> = {
    ...request.metadata,
    order_id: request.orderId,
    order_number: request.orderNumber,
  };
  const entries = Object.entries(metadata);
  if (entries.length > PAYMENT_METADATA_MAX_KEYS) {
    throw new PaymentRequestError(`metadata has more than ${PAYMENT_METADATA_MAX_KEYS} keys`);
  }
  for (const [key, value] of entries) {
    if (key === '' || key.length > PAYMENT_METADATA_KEY_MAX) {
      throw new PaymentRequestError('metadata key is empty or too long');
    }
    if (typeof value !== 'string' || value.length > PAYMENT_METADATA_VALUE_MAX) {
      throw new PaymentRequestError(`metadata value of '${key}' is not a string or too long`);
    }
  }
  return metadata;
}

/** An explicit UTC designator or offset is required: '2026-10-01T00:00:00' alone would be read
 * in the server's local time zone and shift the reconciliation window. */
const TIMESTAMP_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/iu;

function isoTimestamp(value: string, name: string): string {
  const ms = TIMESTAMP_ZONE_RE.test(value.trim()) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new PaymentRequestError(`${name} is not a timestamp with a time zone`);
  }
  return new Date(ms).toISOString();
}

/**
 * The query of a list window (GET /payments, GET /refunds): created_at.gte / created_at.lt with an
 * explicit zone, limit 1..100, the cursor of the previous page. Checked before any request.
 */
function listWindowQuery(request: ListPaymentsRequest): URLSearchParams {
  const limit = request.limit ?? LIST_LIMIT_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
    throw new PaymentRequestError(`limit must be 1..${LIST_LIMIT_MAX}`);
  }
  const createdGte = isoTimestamp(request.createdGte, 'createdGte');
  const createdLt = isoTimestamp(request.createdLt, 'createdLt');
  if (Date.parse(createdGte) >= Date.parse(createdLt)) {
    throw new PaymentRequestError('createdGte must be earlier than createdLt');
  }
  const query = new URLSearchParams({
    'created_at.gte': createdGte,
    'created_at.lt': createdLt,
    limit: String(limit),
  });
  if (request.cursor) query.set('cursor', request.cursor);
  return query;
}

function assertPositiveKop(amountKop: number, what: string): void {
  if (!Number.isSafeInteger(amountKop) || amountKop <= 0) {
    throw new PaymentRequestError(`${what} amount must be a positive integer of kopecks`);
  }
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
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The timeout or the connection broke while the body was streaming: the request was
      // processed or not, exactly like a network error before the headers.
      throw new PaymentProviderError(
        `YooKassa ${method} ${path} failed reading the response: ${(error as Error).name}`,
        { status: null, code: 'network', retryable: true },
      );
    }
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

  /** VERIFY: GET /receipts?payment_id= | ?refund_id= and its cursor pagination. */
  async function listReceipts(
    filter: 'payment_id' | 'refund_id',
    id: string,
  ): Promise<ProviderReceipt[]> {
    const receipts: ProviderReceipt[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const query = new URLSearchParams({ [filter]: id, limit: String(LIST_LIMIT_MAX) });
      if (cursor !== null) query.set('cursor', cursor);
      const list = parseList(await call('GET', `/receipts?${query.toString()}`), 'receipt');
      receipts.push(...list.items.map(parseReceipt));
      if (list.nextCursor === null) return receipts;
      if (seen.has(list.nextCursor)) break;
      seen.add(list.nextCursor);
      cursor = list.nextCursor;
    }
    throw badResponse('receipt list pagination');
  }

  return {
    name: 'yookassa',

    async createPayment(request: CreatePaymentRequest): Promise<ProviderPayment> {
      assertPositiveKop(request.amountKop, 'payment');
      assertPaymentRequest(request);
      // VERIFY Ю9: confirmation {type: 'qr'} (SBP QR at the pickup point) takes no return_url.
      const confirmation =
        request.confirmation === 'qr'
          ? { type: 'qr' }
          : { type: 'redirect', return_url: request.returnUrl };
      const payload: Json = {
        amount: money(request.amountKop),
        capture: true,
        confirmation,
        description: request.description ?? `Заказ ${request.orderNumber}`,
        metadata: paymentMetadata(request),
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
      assertPositiveKop(request.amountKop, 'refund');
      const payload: Json = { payment_id: request.paymentId, amount: money(request.amountKop) };
      if (request.description !== undefined) payload.description = request.description;
      // VERIFY Ю10: a refund receipt travels in the POST /refunds body and repeats the lines and
      // payment_mode of the original receipt; partial refunds carry only the refunded lines.
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

    async listPayments(request: ListPaymentsRequest): Promise<ProviderPaymentPage> {
      // VERIFY: filter names created_at.gte / created_at.lt, limit and cursor of GET /payments.
      const query = listWindowQuery(request);
      const list = parseList(await call('GET', `/payments?${query.toString()}`), 'payment');
      return { items: list.items.map(parsePayment), nextCursor: list.nextCursor };
    },

    async listRefunds(request: ListRefundsRequest): Promise<ProviderRefundPage> {
      // VERIFY: GET /refunds takes the same created_at.gte / created_at.lt, limit and cursor
      // as GET /payments (yookassa.ru/developers/using-api/lists).
      const query = listWindowQuery(request);
      const list = parseList(await call('GET', `/refunds?${query.toString()}`), 'refund');
      return { items: list.items.map(parseRefund), nextCursor: list.nextCursor };
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
        // VERIFY Ю1: offset of the 100% prepayment by settlements [{type: 'prepayment'}].
        settlements: [{ type: 'prepayment', amount: money(request.prepaymentKop) }],
      };
      return parseReceipt(await call('POST', '/receipts', payload, request.idempotenceKey));
    },

    async getReceipt(id: string): Promise<ProviderReceipt> {
      return parseReceipt(await call('GET', `/receipts/${encodeURIComponent(id)}`));
    },

    listPaymentReceipts: (paymentId: string) => listReceipts('payment_id', paymentId),

    listRefundReceipts: (refundId: string) => listReceipts('refund_id', refundId),
  };
}
