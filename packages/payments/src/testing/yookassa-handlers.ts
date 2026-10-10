/**
 * msw 3 emulation of YooKassa API v3 for tests ('@detaly/payments/testing'). No network.
 *
 * Covers POST /payments, GET /payments (list), GET /payments/:id, POST /refunds,
 * GET /refunds (list, step 7), GET /refunds/:id, POST /receipts, GET /receipts (list by
 * payment_id / refund_id), GET /receipts/:id with an in-memory store:
 * - Basic auth is required (and checked against shopId/secretKey when given);
 * - POST requires Idempotence-Key; a repeated key with the same body returns the stored
 *   response, with another body 400 (VERIFY: behaviour of the real API);
 * - receipts must sum to the amount; refunds may not exceed the paid amount, and a refund of a
 *   payment that carried a receipt must carry one too, with the same payment_mode
 *   (VERIFY Ю10);
 * - payments start as `pending` (the redirect confirmation_url is where 3-D Secure happens);
 *   tests move them with `mock.setPaymentStatus`. With capture=true YooKassa does not stop in
 *   waiting_for_capture, so 3-D Secure is emulated as pending → succeeded;
 * - a payment created with a receipt has `receipt_registration: 'pending'`; on success it
 *   becomes `options.receiptRegistration` (default succeeded) and a receipt of type payment
 *   appears in GET /receipts?payment_id= (VERIFY Ю1: field and list format);
 * - fault injection: `failNext(path, status | 'network', {afterProcessing})`, `processingNext`
 *   (HTTP 202 {type: 'processing'}), `delayMs` (timeouts), `rejectTaxSystemCode` (POST
 *   /receipts answers 400 invalid_request).
 * Every request is recorded in `mock.requests` for assertions.
 */
import { randomUUID } from 'node:crypto';
import { delay, http, HttpResponse, type RequestHandler } from 'msw';

type Json = Record<string, unknown>;
type ObjectStatus = 'pending' | 'succeeded' | 'canceled';
type PaymentObjectStatus = ObjectStatus | 'waiting_for_capture';

export interface RecordedRequest {
  method: string;
  /** Path below the API base without the query string, e.g. '/payments'. */
  path: string;
  /** Query string parameters ({} when none). */
  query: Record<string, string>;
  idempotenceKey: string | null;
  authorization: string | null;
  body: Json | null;
}

export interface YooKassaMockOptions {
  apiUrl?: string;
  /** When both are set, Authorization must match them exactly. */
  shopId?: string;
  secretKey?: string;
  /** Status of new refunds (YooKassa usually answers succeeded right away). */
  refundStatus?: ObjectStatus;
  /** Status of new receipts created by POST /receipts (registered asynchronously). */
  receiptStatus?: ObjectStatus;
  /**
   * What receipt_registration of a payment (or refund) with a receipt becomes when it
   * succeeds: succeeded (default), pending (the receipt stays in the queue, poll GET /receipts)
   * or canceled (the receipt was rejected).
   */
  receiptRegistration?: ObjectStatus;
  /** POST /receipts with this tax_system_code answers 400 invalid_request (Verification 13). */
  rejectTaxSystemCode?: number | null;
  /** Delay of every answer, after the request was processed (client timeouts). */
  delayMs?: number;
  /** Clock for created_at / captured_at; default real time. */
  now?: () => Date;
}

export interface FailNextOptions {
  /** How many matching requests fail (default 1). */
  times?: number;
  /**
   * Process the request first (the payment exists in the store), then fail the answer: the
   * "request reached YooKassa, response lost" case that the stable Idempotence-Key protects.
   */
  afterProcessing?: boolean;
  /** retry_after of an HTTP 202 answer, ms (default 1800). */
  retryAfterMs?: number;
}

export interface SetPaymentStatusOptions {
  /** Paid amount different from the requested one (amount mismatch, Verification 16). */
  amountKop?: number;
  /** cancellation_details for `canceled` (default yoo_money / expired_on_confirmation). */
  reason?: string;
  party?: string;
  /** Overrides options.receiptRegistration for this payment. */
  receiptRegistration?: ObjectStatus;
  /** payment_method.type for `succeeded` (default bank_card). */
  method?: string;
}

export interface YooKassaMock {
  handlers: RequestHandler[];
  payments: Map<string, Json>;
  refunds: Map<string, Json>;
  receipts: Map<string, Json>;
  requests: RecordedRequest[];
  /** Changes options at runtime (reset() restores the construction options). */
  configure(patch: Partial<Omit<YooKassaMockOptions, 'apiUrl' | 'shopId' | 'secretKey'>>): void;
  setPaymentStatus(
    id: string,
    status: PaymentObjectStatus,
    options?: SetPaymentStatusOptions,
  ): Json;
  setRefundStatus(id: string, status: ObjectStatus): Json;
  /** Also mirrors the status into receipt_registration of the payment or refund it belongs to. */
  setReceiptStatus(id: string, status: ObjectStatus): Json;
  /** Receipt sent inside a payment: sets receipt_registration and the receipt record. */
  setReceiptRegistration(paymentId: string, status: ObjectStatus): Json;
  /**
   * 3-D Secure: the client is on the bank page behind confirmation_url, the payment stays
   * pending with a known payment_method. Finish it with setPaymentStatus.
   */
  startThreeDSecure(paymentId: string): Json;
  /**
   * Notification body as YooKassa POSTs it: {type: 'notification', event, object}. The object
   * is a snapshot of the stored payment/refund with the status the event implies (payment.succeeded
   * → succeeded), so a notification can disagree with GET, as a forged or early one does;
   * `objectPatch` overrides fields of the object.
   */
  notification(event: string, objectId: string, objectPatch?: Json): Json;
  /**
   * The next `times` requests to `path` fail with `status` ('network' = connection error,
   * 202 = {type: 'processing'}). `path` is '/payments' or 'POST /payments'; without a method
   * any method matches. Paths are compared without the query string.
   */
  failNext(path: string, status: number | 'network', options?: FailNextOptions): void;
  /** Shorthand for failNext(path, 202, options). */
  processingNext(path: string, options?: FailNextOptions): void;
  reset(): void;
}

const AMOUNT_RE = /^\d{1,13}(\.\d{1,2})?$/;
const LIST_LIMIT_MAX = 100;

function toKop(value: string): number {
  const [rub = '0', frac = ''] = value.split('.');
  return Number(rub) * 100 + Number(frac.padEnd(2, '0'));
}

function fromKop(kop: number): string {
  return `${Math.floor(kop / 100)}.${String(kop % 100).padStart(2, '0')}`;
}

const rub = (kop: number): Json => ({ value: fromKop(kop), currency: 'RUB' });

const ERROR_CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'invalid_credentials',
  403: 'forbidden',
  404: 'not_found',
  405: 'not_supported',
  429: 'too_many_requests',
  500: 'internal_server_error',
};

function error(status: number, code: string, description: string, parameter?: string) {
  return HttpResponse.json(
    { type: 'error', id: randomUUID(), code, description, ...(parameter ? { parameter } : {}) },
    { status },
  );
}

const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function amountOf(raw: unknown): number | null {
  if (!isRecord(raw) || raw.currency !== 'RUB' || typeof raw.value !== 'string') return null;
  if (!AMOUNT_RE.test(raw.value)) return null;
  return toKop(raw.value);
}

/** Sum of receipt items in kop, or an error text. */
function itemsTotal(items: unknown): number | string {
  if (!Array.isArray(items) || items.length === 0) return 'receipt.items is empty';
  let total = 0;
  for (const item of items) {
    if (!isRecord(item)) return 'receipt item is not an object';
    const amount = amountOf(item.amount);
    const quantity = Number(item.quantity);
    if (amount === null || !Number.isFinite(quantity) || quantity <= 0) {
      return 'receipt item amount or quantity is invalid';
    }
    if (typeof item.description !== 'string' || item.description.length > 128) {
      return 'receipt item description is invalid';
    }
    total += Math.round(amount * quantity);
  }
  return total;
}

function itemModes(items: unknown): Set<unknown> {
  return new Set(
    Array.isArray(items) ? items.map((i) => (isRecord(i) ? i.payment_mode : null)) : [],
  );
}

const STATUS_BY_EVENT: Record<string, PaymentObjectStatus> = {
  'payment.succeeded': 'succeeded',
  'payment.waiting_for_capture': 'waiting_for_capture',
  'payment.canceled': 'canceled',
  'refund.succeeded': 'succeeded',
};

interface PendingFailure {
  method: string | null;
  path: string;
  status: number | 'network';
  times: number;
  afterProcessing: boolean;
  retryAfterMs: number;
}

/** Opaque list cursor: base64url of the offset. */
const encodeCursor = (offset: number): string => Buffer.from(`o:${offset}`).toString('base64url');
function decodeCursor(cursor: string): number | null {
  const m = /^o:(\d+)$/u.exec(Buffer.from(cursor, 'base64url').toString());
  return m === null ? null : Number(m[1]);
}

export function createYooKassaMock(initialOptions: YooKassaMockOptions = {}): YooKassaMock {
  let options: YooKassaMockOptions = { ...initialOptions };
  const base = (options.apiUrl ?? 'https://api.yookassa.ru/v3').replace(/\/+$/u, '');
  const payments = new Map<string, Json>();
  const refunds = new Map<string, Json>();
  const receipts = new Map<string, Json>();
  /** Receipt body sent inside POST /payments, by payment id. */
  const paymentReceipts = new Map<string, Json>();
  /** Receipt body sent inside POST /refunds, by refund id. */
  const refundReceipts = new Map<string, Json>();
  /** Id of the receipt record registered for a payment's/refund's own receipt. */
  const ownReceiptId = new Map<string, string>();
  /** payment_mode values of receipts registered for a payment (refund receipts must match). */
  const paymentModes = new Map<string, Set<unknown>>();
  const idempotency = new Map<string, { body: string; status: number; response: Json }>();
  const requests: RecordedRequest[] = [];
  const failures: PendingFailure[] = [];
  const expectedAuth =
    options.shopId !== undefined && options.secretKey !== undefined
      ? `Basic ${Buffer.from(`${options.shopId}:${options.secretKey}`).toString('base64')}`
      : null;

  const now = (): string => (options.now?.() ?? new Date()).toISOString();

  function takeFailure(method: string, path: string, afterProcessing: boolean) {
    const index = failures.findIndex(
      (f) =>
        f.path === path &&
        (f.method === null || f.method === method) &&
        f.afterProcessing === afterProcessing,
    );
    if (index === -1) return null;
    const failure = failures[index] as PendingFailure;
    failure.times -= 1;
    if (failure.times <= 0) failures.splice(index, 1);
    return failure;
  }

  function failureResponse(failure: PendingFailure): Response {
    if (failure.status === 'network') return HttpResponse.error();
    if (failure.status === 202) {
      return HttpResponse.json(
        { type: 'processing', description: 'Request accepted', retry_after: failure.retryAfterMs },
        { status: 202 },
      );
    }
    return error(
      failure.status,
      ERROR_CODES[failure.status] ?? 'internal_server_error',
      `injected HTTP ${failure.status}`,
    );
  }

  interface Context {
    request: Request;
    path: string;
    query: URLSearchParams;
    body: Json;
    params: Record<string, string>;
  }

  /**
   * Common pipeline: record → injected failure → auth and Idempotence-Key → handler → injected
   * failure after processing → delay.
   */
  function route(
    method: 'GET' | 'POST',
    pattern: string,
    pathOf: (params: Record<string, string>) => string,
    handle: (ctx: Context) => Response | Promise<Response>,
  ): RequestHandler {
    const resolver = async ({
      request,
      params,
    }: {
      request: Request;
      params: Record<string, string | readonly string[] | undefined>;
    }): Promise<Response> => {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(params)) if (typeof v === 'string') flat[k] = v;
      const path = pathOf(flat);
      const url = new URL(request.url);
      const authorization = request.headers.get('authorization');
      const idempotenceKey = request.headers.get('idempotence-key');
      let body: Json | null = null;
      if (method === 'POST') {
        const parsed: unknown = await request.json().catch(() => null);
        body = isRecord(parsed) ? parsed : null;
      }
      requests.push({
        method,
        path,
        query: Object.fromEntries(url.searchParams),
        idempotenceKey,
        authorization,
        body,
      });
      const before = takeFailure(method, path, false);
      if (before !== null) return failureResponse(before);
      if (authorization === null || !authorization.startsWith('Basic ')) {
        return error(401, 'invalid_credentials', 'Authorization required');
      }
      if (expectedAuth !== null && authorization !== expectedAuth) {
        return error(401, 'invalid_credentials', 'Wrong shopId or secret key');
      }
      if (method === 'POST') {
        if (idempotenceKey === null || idempotenceKey === '') {
          return error(400, 'invalid_request', 'Idempotence-Key is required', 'Idempotence-Key');
        }
        if (body === null) return error(400, 'invalid_request', 'JSON body required');
      }
      const response = await handle({
        request,
        path,
        query: url.searchParams,
        body: body ?? {},
        params: flat,
      });
      const after = takeFailure(method, path, true);
      if ((options.delayMs ?? 0) > 0) await delay(options.delayMs);
      return after === null ? response : failureResponse(after);
    };
    return method === 'POST'
      ? http.post(`${base}${pattern}`, resolver)
      : http.get(`${base}${pattern}`, resolver);
  }

  /** Runs `create` once per Idempotence-Key and replays its answer afterwards. */
  function idempotent(ctx: Context, create: () => { status: number; response: Json }): Response {
    const key = `${ctx.path}|${ctx.request.headers.get('idempotence-key') ?? ''}`;
    const serialized = JSON.stringify(ctx.body);
    const seen = idempotency.get(key);
    if (seen !== undefined) {
      if (seen.body !== serialized) {
        return error(400, 'invalid_request', 'Idempotence key reused with other parameters');
      }
      return HttpResponse.json(seen.response, { status: seen.status });
    }
    const result = create();
    idempotency.set(key, { body: serialized, ...result });
    return HttpResponse.json(result.response, { status: result.status });
  }

  function badRequest(description: string, parameter: string): { status: number; response: Json } {
    return {
      status: 400,
      response: {
        type: 'error',
        id: randomUUID(),
        code: 'invalid_request',
        description,
        parameter,
      },
    };
  }

  /** {type: 'list', items, next_cursor?} with limit/cursor validation (VERIFY list format). */
  function listResponse(items: Json[], query: URLSearchParams): Response {
    const limitText = query.get('limit');
    const limit = limitText === null ? 10 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
      return error(400, 'invalid_request', 'limit is invalid', 'limit');
    }
    const cursor = query.get('cursor');
    const offset = cursor === null ? 0 : decodeCursor(cursor);
    if (offset === null) return error(400, 'invalid_request', 'cursor is invalid', 'cursor');
    const page = items.slice(offset, offset + limit);
    const more = offset + limit < items.length;
    return HttpResponse.json({
      type: 'list',
      items: page,
      ...(more ? { next_cursor: encodeCursor(offset + limit) } : {}),
    });
  }

  /** created_at filters of list endpoints: created_at.gte/gt/lte/lt. */
  function createdAtFilter(query: URLSearchParams): ((createdAt: unknown) => boolean) | string {
    const bounds: Array<[string, (a: number, b: number) => boolean]> = [
      ['created_at.gte', (a, b) => a >= b],
      ['created_at.gt', (a, b) => a > b],
      ['created_at.lte', (a, b) => a <= b],
      ['created_at.lt', (a, b) => a < b],
    ];
    const checks: Array<(t: number) => boolean> = [];
    for (const [name, cmp] of bounds) {
      const value = query.get(name);
      if (value === null) continue;
      const bound = Date.parse(value);
      if (Number.isNaN(bound)) return name;
      checks.push((t) => cmp(t, bound));
    }
    return (createdAt) => {
      const t = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
      return checks.every((check) => check(t));
    };
  }

  function registerReceipt(record: Json): Json {
    const receipt: Json = { id: randomUUID(), ...record };
    if (receipt.status === 'succeeded') {
      receipt.fiscal_document_number = '3986';
      receipt.registered_at = now();
    }
    receipts.set(String(receipt.id), receipt);
    return receipt;
  }

  /** The receipt sent inside a payment is registered when the payment succeeds. */
  function registerPaymentReceipt(payment: Json, status: ObjectStatus): void {
    const id = String(payment.id);
    const body = paymentReceipts.get(id);
    if (body === undefined) return;
    payment.receipt_registration = status;
    const existing = ownReceiptId.get(id);
    if (existing !== undefined) {
      const receipt = receipts.get(existing);
      if (receipt !== undefined) {
        receipt.status = status;
        if (status === 'succeeded') {
          receipt.fiscal_document_number ??= '3986';
          receipt.registered_at ??= now();
        }
      }
      return;
    }
    const receipt = registerReceipt({
      type: 'payment',
      payment_id: id,
      status,
      items: body.items,
      // VERIFY Ю1: settlement type of a receipt inside an online payment.
      settlements: [{ type: 'cashless', amount: payment.amount }],
      tax_system_code: body.tax_system_code,
    });
    ownReceiptId.set(id, String(receipt.id));
  }

  function registerRefundReceipt(refund: Json, status: ObjectStatus): void {
    const id = String(refund.id);
    const body = refundReceipts.get(id);
    if (body === undefined) return;
    refund.receipt_registration = status;
    const existing = ownReceiptId.get(id);
    if (existing !== undefined) {
      const receipt = receipts.get(existing);
      if (receipt !== undefined) receipt.status = status;
      return;
    }
    const receipt = registerReceipt({
      type: 'refund',
      refund_id: id,
      status,
      items: body.items,
      settlements: [{ type: 'cashless', amount: refund.amount }],
      tax_system_code: body.tax_system_code,
    });
    ownReceiptId.set(id, String(receipt.id));
  }

  const handlers: RequestHandler[] = [
    route(
      'POST',
      '/payments',
      () => '/payments',
      (ctx) =>
        idempotent(ctx, () => {
          const payload = ctx.body;
          const amount = amountOf(payload.amount);
          if (amount === null || amount <= 0) {
            return badRequest('amount is invalid', 'amount');
          }
          if (
            payload.description !== undefined &&
            (typeof payload.description !== 'string' || payload.description.length > 128)
          ) {
            return badRequest('description is too long', 'description');
          }
          if (payload.receipt !== undefined) {
            const receipt = payload.receipt;
            const total = isRecord(receipt) ? itemsTotal(receipt.items) : 'receipt is invalid';
            if (typeof total === 'string') return badRequest(total, 'receipt');
            if (total !== amount) {
              return badRequest('receipt items sum differs from amount', 'receipt');
            }
            if (itemModes(isRecord(receipt) ? receipt.items : null).size !== 1) {
              return badRequest('receipt items have different payment_mode', 'receipt');
            }
          }
          const confirmation = isRecord(payload.confirmation) ? payload.confirmation : {};
          if (confirmation.type === 'qr' && confirmation.return_url !== undefined) {
            return badRequest('qr confirmation has no return_url', 'confirmation.return_url');
          }
          if (confirmation.type !== 'qr' && typeof confirmation.return_url !== 'string') {
            return badRequest('return_url is required', 'confirmation.return_url');
          }
          const id = randomUUID();
          const payment: Json = {
            id,
            status: 'pending',
            paid: false,
            amount: payload.amount,
            description: payload.description,
            metadata: payload.metadata ?? {},
            created_at: now(),
            confirmation:
              confirmation.type === 'qr'
                ? { type: 'qr', confirmation_data: `https://qr.nspk.ru/mock/${id}` }
                : {
                    type: 'redirect',
                    confirmation_url: `https://yoomoney.ru/checkout/payments/v2/contract?orderId=${id}`,
                    return_url: confirmation.return_url,
                  },
            recipient: { account_id: options.shopId ?? 'mock', gateway_id: 'mock' },
            refundable: false,
            test: true,
            ...(payload.receipt === undefined ? {} : { receipt_registration: 'pending' }),
          };
          payments.set(id, payment);
          if (isRecord(payload.receipt)) {
            paymentReceipts.set(id, payload.receipt);
            paymentModes.set(id, itemModes(payload.receipt.items));
          }
          return { status: 200, response: payment };
        }),
    ),

    route(
      'GET',
      '/payments',
      () => '/payments',
      ({ query }) => {
        const filter = createdAtFilter(query);
        if (typeof filter === 'string')
          return error(400, 'invalid_request', `${filter} is invalid`, filter);
        const status = query.get('status');
        // VERIFY: order of GET /payments (newest first assumed).
        const items = [...payments.values()]
          .filter((p) => filter(p.created_at) && (status === null || p.status === status))
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return listResponse(items, query);
      },
    ),

    route(
      'GET',
      '/payments/:id',
      (p) => `/payments/${p.id ?? ''}`,
      ({ params }) => {
        const payment = payments.get(params.id ?? '');
        return payment ? HttpResponse.json(payment) : error(404, 'not_found', 'Payment not found');
      },
    ),

    route(
      'POST',
      '/refunds',
      () => '/refunds',
      (ctx) =>
        idempotent(ctx, () => {
          const payload = ctx.body;
          const payment = payments.get(String(payload.payment_id));
          if (payment === undefined) return badRequest('payment not found', 'payment_id');
          if (payment.status !== 'succeeded') {
            return badRequest('payment is not succeeded', 'payment_id');
          }
          const amount = amountOf(payload.amount);
          if (amount === null || amount <= 0) return badRequest('amount is invalid', 'amount');
          const paid = amountOf(payment.amount) ?? 0;
          const refunded = amountOf(payment.refunded_amount) ?? 0;
          if (refunded + amount > paid) return badRequest('refund exceeds payment', 'amount');
          const original = paymentModes.get(String(payment.id));
          if (payload.receipt === undefined && original !== undefined) {
            // VERIFY Ю10: with receipts enabled a refund of a payment with a receipt needs one.
            return badRequest('receipt is required', 'receipt');
          }
          if (payload.receipt !== undefined) {
            const receipt = payload.receipt;
            const items = isRecord(receipt) ? receipt.items : null;
            const total = itemsTotal(items);
            if (typeof total === 'string') return badRequest(total, 'receipt');
            if (total !== amount) {
              return badRequest('receipt items sum differs from amount', 'receipt');
            }
            if (original !== undefined) {
              for (const mode of itemModes(items)) {
                if (!original.has(mode)) {
                  return badRequest(
                    'receipt payment_mode differs from the original receipt',
                    'receipt.items.payment_mode',
                  );
                }
              }
            }
          }
          const status = options.refundStatus ?? 'succeeded';
          const refund: Json = {
            id: randomUUID(),
            payment_id: payment.id,
            status,
            amount: payload.amount,
            created_at: now(),
            description: payload.description,
          };
          refunds.set(String(refund.id), refund);
          if (isRecord(payload.receipt)) {
            refundReceipts.set(String(refund.id), payload.receipt);
            refund.receipt_registration = 'pending';
            if (status === 'succeeded') {
              registerRefundReceipt(refund, options.receiptRegistration ?? 'succeeded');
            }
          }
          if (status === 'canceled') {
            refund.cancellation_details = { party: 'yoo_money', reason: 'rejected_by_payee' };
          } else {
            payment.refunded_amount = rub(refunded + amount);
          }
          return { status: 200, response: refund };
        }),
    ),

    route(
      'GET',
      '/refunds',
      () => '/refunds',
      ({ query }) => {
        const filter = createdAtFilter(query);
        if (typeof filter === 'string')
          return error(400, 'invalid_request', `${filter} is invalid`, filter);
        const status = query.get('status');
        const paymentId = query.get('payment_id');
        // VERIFY: order of GET /refunds (newest first assumed, as for payments).
        const items = [...refunds.values()]
          .filter(
            (r) =>
              filter(r.created_at) &&
              (status === null || r.status === status) &&
              (paymentId === null || r.payment_id === paymentId),
          )
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return listResponse(items, query);
      },
    ),

    route(
      'GET',
      '/refunds/:id',
      (p) => `/refunds/${p.id ?? ''}`,
      ({ params }) => {
        const refund = refunds.get(params.id ?? '');
        return refund ? HttpResponse.json(refund) : error(404, 'not_found', 'Refund not found');
      },
    ),

    route(
      'POST',
      '/receipts',
      () => '/receipts',
      (ctx) =>
        idempotent(ctx, () => {
          const payload = ctx.body;
          if (payload.type !== 'payment' && payload.type !== 'refund') {
            return badRequest('type must be payment or refund', 'type');
          }
          if (
            options.rejectTaxSystemCode !== undefined &&
            options.rejectTaxSystemCode !== null &&
            payload.tax_system_code === options.rejectTaxSystemCode
          ) {
            return badRequest('tax_system_code is not allowed for the shop', 'tax_system_code');
          }
          if (payload.type === 'payment') {
            const payment = payments.get(String(payload.payment_id));
            if (payment === undefined) return badRequest('payment not found', 'payment_id');
            if (payment.status !== 'succeeded') {
              return badRequest('payment is not succeeded', 'payment_id');
            }
          }
          const total = itemsTotal(payload.items);
          if (typeof total === 'string') return badRequest(total, 'items');
          const settlements = payload.settlements;
          if (!Array.isArray(settlements) || settlements.length === 0) {
            return badRequest('settlements are required', 'settlements');
          }
          let settled = 0;
          for (const s of settlements) {
            const amount = isRecord(s) ? amountOf(s.amount) : null;
            if (amount === null) return badRequest('settlement amount is invalid', 'settlements');
            settled += amount;
          }
          if (settled !== total) {
            return badRequest('settlements differ from items sum', 'settlements');
          }
          const receipt = registerReceipt({
            type: payload.type,
            payment_id: payload.payment_id,
            status: options.receiptStatus ?? 'pending',
            items: payload.items,
            settlements,
            tax_system_code: payload.tax_system_code,
          });
          if (payload.type === 'payment') {
            // A refund after the offset receipt may mirror its payment_mode (full_payment).
            const modes = paymentModes.get(String(payload.payment_id)) ?? new Set();
            for (const mode of itemModes(payload.items)) modes.add(mode);
            paymentModes.set(String(payload.payment_id), modes);
          }
          return { status: 200, response: receipt };
        }),
    ),

    route(
      'GET',
      '/receipts',
      () => '/receipts',
      ({ query }) => {
        const paymentId = query.get('payment_id');
        const refundId = query.get('refund_id');
        if (paymentId !== null && refundId !== null) {
          return error(400, 'invalid_request', 'payment_id and refund_id are exclusive');
        }
        const filter = createdAtFilter(query);
        if (typeof filter === 'string')
          return error(400, 'invalid_request', `${filter} is invalid`, filter);
        const items = [...receipts.values()].filter(
          (r) =>
            (paymentId === null || r.payment_id === paymentId) &&
            (refundId === null || r.refund_id === refundId) &&
            (r.created_at === undefined || filter(r.created_at)),
        );
        return listResponse(items, query);
      },
    ),

    route(
      'GET',
      '/receipts/:id',
      (p) => `/receipts/${p.id ?? ''}`,
      ({ params }) => {
        const receipt = receipts.get(params.id ?? '');
        return receipt ? HttpResponse.json(receipt) : error(404, 'not_found', 'Receipt not found');
      },
    ),
  ];

  function update(store: Map<string, Json>, what: string, id: string, patch: Json): Json {
    const object = store.get(id);
    if (object === undefined) throw new Error(`mock ${what} ${id} not found`);
    Object.assign(object, patch);
    return object;
  }

  function find(store: Map<string, Json>, what: string, id: string): Json {
    const object = store.get(id);
    if (object === undefined) throw new Error(`mock ${what} ${id} not found`);
    return object;
  }

  return {
    handlers,
    payments,
    refunds,
    receipts,
    requests,
    configure(patch) {
      options = { ...options, ...patch };
    },
    setPaymentStatus(id, status, extra = {}) {
      const payment = find(payments, 'payment', id);
      const patch: Json = {
        status,
        paid: status === 'succeeded' || status === 'waiting_for_capture',
      };
      if (extra.amountKop !== undefined) patch.amount = rub(extra.amountKop);
      if (status === 'succeeded') {
        patch.captured_at = now();
        patch.refundable = true;
        patch.payment_method = { type: extra.method ?? 'bank_card', id, saved: false };
      }
      if (status === 'canceled') {
        patch.cancellation_details = {
          party: extra.party ?? 'yoo_money',
          reason: extra.reason ?? 'expired_on_confirmation',
        };
      }
      Object.assign(payment, patch);
      if (status === 'succeeded') {
        registerPaymentReceipt(
          payment,
          extra.receiptRegistration ?? options.receiptRegistration ?? 'succeeded',
        );
      }
      return payment;
    },
    setRefundStatus(id, status) {
      const previous = find(refunds, 'refund', id).status;
      const refund = update(refunds, 'refund', id, { status });
      if (status === 'succeeded') {
        registerRefundReceipt(refund, options.receiptRegistration ?? 'succeeded');
      }
      if (status === 'canceled' && previous !== 'canceled') {
        refund.cancellation_details = { party: 'yoo_money', reason: 'rejected_by_payee' };
        // A canceled refund gives the money back to the refundable balance of the payment.
        const payment = payments.get(String(refund.payment_id));
        if (payment !== undefined) {
          const refunded =
            (amountOf(payment.refunded_amount) ?? 0) - (amountOf(refund.amount) ?? 0);
          payment.refunded_amount = rub(Math.max(0, refunded));
        }
      }
      return refund;
    },
    setReceiptStatus(id, status) {
      const patch: Json = { status };
      if (status === 'succeeded') {
        patch.fiscal_document_number = '3986';
        patch.registered_at = now();
      }
      const receipt = update(receipts, 'receipt', id, patch);
      for (const [ownerId, receiptId] of ownReceiptId) {
        if (receiptId !== id) continue;
        const owner = payments.get(ownerId) ?? refunds.get(ownerId);
        if (owner !== undefined) owner.receipt_registration = status;
      }
      return receipt;
    },
    setReceiptRegistration(paymentId, status) {
      const payment = find(payments, 'payment', paymentId);
      if (!paymentReceipts.has(paymentId)) {
        throw new Error(`mock payment ${paymentId} was created without a receipt`);
      }
      registerPaymentReceipt(payment, status);
      return payment;
    },
    startThreeDSecure(paymentId) {
      const payment = find(payments, 'payment', paymentId);
      if (payment.status !== 'pending') {
        throw new Error(`mock payment ${paymentId} is ${String(payment.status)}, not pending`);
      }
      payment.payment_method = {
        type: 'bank_card',
        id: paymentId,
        saved: false,
        card: { first6: '555555', last4: '4477', card_type: 'MasterCard' },
      };
      return payment;
    },
    notification(event, objectId, objectPatch = {}) {
      const store = event.startsWith('refund.') ? refunds : payments;
      const stored = store.get(objectId);
      const object: Json = stored === undefined ? { id: objectId } : structuredClone(stored);
      const status = STATUS_BY_EVENT[event];
      if (status !== undefined) {
        object.status = status;
        if (!event.startsWith('refund.')) {
          object.paid = status === 'succeeded' || status === 'waiting_for_capture';
        }
      }
      return { type: 'notification', event, object: { ...object, ...objectPatch } };
    },
    failNext(path, status, failOptions = {}) {
      const m = /^(GET|POST)\s+(\S+)$/u.exec(path.trim());
      failures.push({
        method: m?.[1] ?? null,
        path: (m?.[2] ?? path.trim()).split('?')[0] ?? '',
        status,
        times: failOptions.times ?? 1,
        afterProcessing: failOptions.afterProcessing ?? false,
        retryAfterMs: failOptions.retryAfterMs ?? 1800,
      });
    },
    processingNext(path, failOptions = {}) {
      this.failNext(path, 202, failOptions);
    },
    reset() {
      options = { ...initialOptions };
      payments.clear();
      refunds.clear();
      receipts.clear();
      paymentReceipts.clear();
      refundReceipts.clear();
      ownReceiptId.clear();
      paymentModes.clear();
      idempotency.clear();
      failures.length = 0;
      requests.length = 0;
    },
  };
}

/** Handlers only (a fresh in-memory store per call). */
export function createYooKassaHandlers(options: YooKassaMockOptions = {}): RequestHandler[] {
  return createYooKassaMock(options).handlers;
}
