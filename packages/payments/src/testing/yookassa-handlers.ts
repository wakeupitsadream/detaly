/**
 * msw 3 emulation of YooKassa API v3 for tests ('@detaly/payments/testing'). No network.
 *
 * Covers POST /payments, GET /payments/:id, POST /refunds, GET /refunds/:id, POST /receipts,
 * GET /receipts/:id with an in-memory store:
 * - Basic auth is required (and checked against shopId/secretKey when given);
 * - POST requires Idempotence-Key; a repeated key with the same body returns the stored
 *   response, with another body 400 (behaviour of the real API to verify);
 * - receipts must sum to the amount, refunds may not exceed the paid amount;
 * - payments start as `pending`; tests move them with `mock.setPaymentStatus`.
 * Every request is recorded in `mock.requests` for assertions.
 */
import { randomUUID } from 'node:crypto';
import { http, HttpResponse, type RequestHandler } from 'msw';

type Json = Record<string, unknown>;

export interface RecordedRequest {
  method: string;
  path: string;
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
  refundStatus?: 'pending' | 'succeeded' | 'canceled';
  /** Status of new receipts (real receipts are registered asynchronously). */
  receiptStatus?: 'pending' | 'succeeded' | 'canceled';
}

export interface YooKassaMock {
  handlers: RequestHandler[];
  payments: Map<string, Json>;
  refunds: Map<string, Json>;
  receipts: Map<string, Json>;
  requests: RecordedRequest[];
  setPaymentStatus(id: string, status: 'pending' | 'succeeded' | 'canceled'): Json;
  setRefundStatus(id: string, status: 'pending' | 'succeeded' | 'canceled'): Json;
  setReceiptStatus(id: string, status: 'pending' | 'succeeded' | 'canceled'): Json;
  /** Notification body as YooKassa would POST it to our webhook. */
  notification(event: string, objectId: string): Json;
  reset(): void;
}

const AMOUNT_RE = /^\d{1,13}(\.\d{1,2})?$/;

function toKop(value: string): number {
  const [rub = '0', frac = ''] = value.split('.');
  return Number(rub) * 100 + Number(frac.padEnd(2, '0'));
}

function fromKop(kop: number): string {
  return `${Math.floor(kop / 100)}.${String(kop % 100).padStart(2, '0')}`;
}

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

export function createYooKassaMock(options: YooKassaMockOptions = {}): YooKassaMock {
  const base = (options.apiUrl ?? 'https://api.yookassa.ru/v3').replace(/\/+$/u, '');
  const payments = new Map<string, Json>();
  const refunds = new Map<string, Json>();
  const receipts = new Map<string, Json>();
  const idempotency = new Map<string, { body: string; status: number; response: Json }>();
  const requests: RecordedRequest[] = [];
  const expectedAuth =
    options.shopId !== undefined && options.secretKey !== undefined
      ? `Basic ${Buffer.from(`${options.shopId}:${options.secretKey}`).toString('base64')}`
      : null;

  async function prepare(
    request: Request,
    path: string,
  ): Promise<{ body: Json | null; fail?: Response }> {
    const authorization = request.headers.get('authorization');
    const idempotenceKey = request.headers.get('idempotence-key');
    let body: Json | null = null;
    if (request.method === 'POST') {
      const parsed: unknown = await request.json().catch(() => null);
      body = isRecord(parsed) ? parsed : null;
    }
    requests.push({ method: request.method, path, idempotenceKey, authorization, body });
    if (authorization === null || !authorization.startsWith('Basic ')) {
      return { body, fail: error(401, 'invalid_credentials', 'Authorization required') };
    }
    if (expectedAuth !== null && authorization !== expectedAuth) {
      return { body, fail: error(401, 'invalid_credentials', 'Wrong shopId or secret key') };
    }
    if (request.method === 'POST') {
      if (idempotenceKey === null || idempotenceKey === '') {
        return {
          body,
          fail: error(400, 'invalid_request', 'Idempotence-Key is required', 'Idempotence-Key'),
        };
      }
      if (body === null) return { body, fail: error(400, 'invalid_request', 'JSON body required') };
    }
    return { body };
  }

  /** Runs `create` once per Idempotence-Key and replays its answer afterwards. */
  function idempotent(
    request: Request,
    path: string,
    body: Json,
    create: () => { status: number; response: Json },
  ): Response {
    const key = `${path}|${request.headers.get('idempotence-key') ?? ''}`;
    const serialized = JSON.stringify(body);
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

  const now = (): string => new Date().toISOString();

  const handlers: RequestHandler[] = [
    http.post(`${base}/payments`, async ({ request }) => {
      const { body, fail } = await prepare(request, '/payments');
      if (fail) return fail;
      const payload = body as Json;
      return idempotent(request, '/payments', payload, () => {
        const amount = amountOf(payload.amount);
        if (amount === null || amount <= 0) {
          return badRequest('amount is invalid', 'amount');
        }
        if (payload.receipt !== undefined) {
          const receipt = payload.receipt;
          const total = isRecord(receipt) ? itemsTotal(receipt.items) : 'receipt is invalid';
          if (typeof total === 'string') return badRequest(total, 'receipt');
          if (total !== amount)
            return badRequest('receipt items sum differs from amount', 'receipt');
        }
        const confirmation = isRecord(payload.confirmation) ? payload.confirmation : {};
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
        return { status: 200, response: payment };
      });
    }),

    http.get(`${base}/payments/:id`, async ({ request, params }) => {
      const id = String(params.id);
      const { fail } = await prepare(request, `/payments/${id}`);
      if (fail) return fail;
      const payment = payments.get(id);
      return payment ? HttpResponse.json(payment) : error(404, 'not_found', 'Payment not found');
    }),

    http.post(`${base}/refunds`, async ({ request }) => {
      const { body, fail } = await prepare(request, '/refunds');
      if (fail) return fail;
      const payload = body as Json;
      return idempotent(request, '/refunds', payload, () => {
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
        if (payload.receipt !== undefined) {
          const receipt = payload.receipt;
          const total = isRecord(receipt) ? itemsTotal(receipt.items) : 'receipt is invalid';
          if (typeof total === 'string') return badRequest(total, 'receipt');
          if (total !== amount)
            return badRequest('receipt items sum differs from amount', 'receipt');
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
        if (status !== 'canceled') {
          payment.refunded_amount = { value: fromKop(refunded + amount), currency: 'RUB' };
        }
        return { status: 200, response: refund };
      });
    }),

    http.get(`${base}/refunds/:id`, async ({ request, params }) => {
      const id = String(params.id);
      const { fail } = await prepare(request, `/refunds/${id}`);
      if (fail) return fail;
      const refund = refunds.get(id);
      return refund ? HttpResponse.json(refund) : error(404, 'not_found', 'Refund not found');
    }),

    http.post(`${base}/receipts`, async ({ request }) => {
      const { body, fail } = await prepare(request, '/receipts');
      if (fail) return fail;
      const payload = body as Json;
      return idempotent(request, '/receipts', payload, () => {
        if (payload.type !== 'payment' && payload.type !== 'refund') {
          return badRequest('type must be payment or refund', 'type');
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
        if (settled !== total)
          return badRequest('settlements differ from items sum', 'settlements');
        const receipt: Json = {
          id: randomUUID(),
          type: payload.type,
          payment_id: payload.payment_id,
          status: options.receiptStatus ?? 'pending',
          items: payload.items,
          settlements,
          tax_system_code: payload.tax_system_code,
        };
        receipts.set(String(receipt.id), receipt);
        return { status: 200, response: receipt };
      });
    }),

    http.get(`${base}/receipts/:id`, async ({ request, params }) => {
      const id = String(params.id);
      const { fail } = await prepare(request, `/receipts/${id}`);
      if (fail) return fail;
      const receipt = receipts.get(id);
      return receipt ? HttpResponse.json(receipt) : error(404, 'not_found', 'Receipt not found');
    }),
  ];

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

  function update(store: Map<string, Json>, what: string, id: string, patch: Json): Json {
    const object = store.get(id);
    if (object === undefined) throw new Error(`mock ${what} ${id} not found`);
    Object.assign(object, patch);
    return object;
  }

  return {
    handlers,
    payments,
    refunds,
    receipts,
    requests,
    setPaymentStatus(id, status) {
      const patch: Json = { status, paid: status === 'succeeded' };
      if (status === 'succeeded') {
        patch.captured_at = now();
        patch.refundable = true;
        patch.payment_method = { type: 'bank_card', id, saved: false };
        if (payments.get(id)?.receipt_registration !== undefined) {
          patch.receipt_registration = 'succeeded';
        }
      }
      if (status === 'canceled') {
        patch.cancellation_details = { party: 'yoo_money', reason: 'expired_on_confirmation' };
      }
      return update(payments, 'payment', id, patch);
    },
    setRefundStatus: (id, status) => update(refunds, 'refund', id, { status }),
    setReceiptStatus(id, status) {
      const patch: Json = { status };
      if (status === 'succeeded') patch.fiscal_document_number = '3986';
      return update(receipts, 'receipt', id, patch);
    },
    notification(event, objectId) {
      const store = event.startsWith('refund.') ? refunds : payments;
      return { type: 'notification', event, object: store.get(objectId) ?? { id: objectId } };
    },
    reset() {
      payments.clear();
      refunds.clear();
      receipts.clear();
      idempotency.clear();
      requests.length = 0;
    },
  };
}

/** Handlers only (a fresh in-memory store per call). */
export function createYooKassaHandlers(options: YooKassaMockOptions = {}): RequestHandler[] {
  return createYooKassaMock(options).handlers;
}
