// Phase 1B additions to the YooKassa adapter, exercised only against the msw emulation.
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createYooKassaProvider,
  PaymentProviderError,
  PaymentRequestError,
  type ProviderPayment,
} from '../src';
import { createYooKassaMock } from '../src/testing/yookassa-handlers';
import { API, line, ORDER_ID, prepayRequest, SECRET_KEY, SHOP_ID } from './helpers';

const mock = createYooKassaMock({ apiUrl: API, shopId: SHOP_ID, secretKey: SECRET_KEY });
const server = setupServer(...mock.handlers);

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  mock.reset();
});
afterAll(() => server.close());

const provider = createYooKassaProvider({ shopId: SHOP_ID, secretKey: SECRET_KEY, apiUrl: API });

/** pay_on_handover: QR at the pickup point with a full_payment receipt. */
const handoverRequest = {
  ...prepayRequest,
  idempotenceKey: 'qr-DT-000123-1',
  confirmation: 'qr' as const,
  returnUrl: undefined,
  receipt: { ...prepayRequest.receipt, lines: [line({ paymentMode: 'full_payment' })] },
};

async function paidPrepayment(): Promise<ProviderPayment> {
  const payment = await provider.createPayment(prepayRequest);
  mock.setPaymentStatus(payment.id, 'succeeded');
  return payment;
}

describe('receipt inside the payment', () => {
  it('prepay: full_prepayment receipt, receipt_registration pending → succeeded', async () => {
    const created = await provider.createPayment({
      ...prepayRequest,
      metadata: { payment_row_id: 'row-1' },
    });
    expect(created).toMatchObject({
      status: 'pending',
      currency: 'RUB',
      receiptRegistration: 'pending',
      paidAt: null,
      cancellationReason: null,
      refundedAmountKop: 0,
      metadata: { order_id: ORDER_ID, order_number: 'DT-000123', payment_row_id: 'row-1' },
    });
    expect(mock.requests[0]?.body).toMatchObject({
      capture: true,
      confirmation: { type: 'redirect', return_url: prepayRequest.returnUrl },
      receipt: { tax_system_code: 2, items: [{ payment_mode: 'full_prepayment' }] },
    });

    mock.setPaymentStatus(created.id, 'succeeded');
    const paid = await provider.getPayment(created.id);
    expect(paid).toMatchObject({
      status: 'succeeded',
      paid: true,
      receiptRegistration: 'succeeded',
    });
    expect(paid.paidAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const receipts = await provider.listPaymentReceipts(created.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      type: 'payment',
      status: 'succeeded',
      paymentId: created.id,
      paymentMode: 'full_prepayment',
      settlementTypes: ['cashless'],
      fiscalDocumentNumber: '3986',
    });
    expect(mock.requests.at(-1)).toMatchObject({
      method: 'GET',
      path: '/receipts',
      query: { payment_id: created.id, limit: '100' },
    });
  });

  it('pay_on_handover: QR without return_url and a full_payment receipt', async () => {
    const created = await provider.createPayment(handoverRequest);
    expect(created.confirmationData).toMatch(/^https:\/\/qr\.nspk\.ru\//);
    expect(created.confirmationUrl).toBeNull();
    const body = mock.requests[0]?.body;
    expect(body?.confirmation).toEqual({ type: 'qr' });
    expect(body).toMatchObject({ receipt: { items: [{ payment_mode: 'full_payment' }] } });

    mock.setPaymentStatus(created.id, 'succeeded', { method: 'sbp' });
    expect(await provider.getPayment(created.id)).toMatchObject({
      method: 'sbp',
      receiptRegistration: 'succeeded',
    });
    expect(await provider.listPaymentReceipts(created.id)).toMatchObject([
      { paymentMode: 'full_payment', status: 'succeeded' },
    ]);
  });

  it('receipt still pending: the list shows it pending until YooKassa registers it', async () => {
    mock.configure({ receiptRegistration: 'pending' });
    const payment = await paidPrepayment();
    expect((await provider.getPayment(payment.id)).receiptRegistration).toBe('pending');
    const [receipt] = await provider.listPaymentReceipts(payment.id);
    expect(receipt?.status).toBe('pending');

    mock.setReceiptStatus(receipt?.id ?? '', 'succeeded');
    expect((await provider.getPayment(payment.id)).receiptRegistration).toBe('succeeded');
    expect(await provider.getReceipt(receipt?.id ?? '')).toMatchObject({ status: 'succeeded' });
  });

  it('receipt rejected: receipt_registration canceled', async () => {
    const created = await provider.createPayment(prepayRequest);
    mock.setPaymentStatus(created.id, 'succeeded', { receiptRegistration: 'canceled' });
    expect((await provider.getPayment(created.id)).receiptRegistration).toBe('canceled');
    expect(await provider.listPaymentReceipts(created.id)).toMatchObject([{ status: 'canceled' }]);
  });

  it('a payment without a receipt has receiptRegistration null and no receipts', async () => {
    const created = await provider.createPayment({ ...prepayRequest, receipt: null });
    mock.setPaymentStatus(created.id, 'succeeded');
    expect((await provider.getPayment(created.id)).receiptRegistration).toBeNull();
    expect(await provider.listPaymentReceipts(created.id)).toEqual([]);
  });

  it('the emulation rejects a receipt with mixed payment_mode', async () => {
    await expect(
      provider.createPayment({
        ...prepayRequest,
        receipt: {
          customer: {},
          lines: [line({ quantity: 1 }), line({ quantity: 1, paymentMode: 'full_payment' })],
        },
      }),
    ).rejects.toThrow(/payment_mode/);
  });
});

describe('request limits (VERIFY Ю11)', () => {
  it('description defaults to the order number and is at most 128 characters', async () => {
    await provider.createPayment({ ...prepayRequest, description: 'Заказ DT-000123 в «Деталях»' });
    expect(mock.requests[0]?.body?.description).toBe('Заказ DT-000123 в «Деталях»');
    await expect(
      provider.createPayment({ ...prepayRequest, description: 'я'.repeat(129) }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    await expect(provider.createPayment({ ...prepayRequest, description: ' ' })).rejects.toThrow(
      PaymentRequestError,
    );
    expect(mock.requests).toHaveLength(1);
  });

  it('metadata: at most 16 keys, key ≤ 32, value ≤ 512; order keys always win', async () => {
    const created = await provider.createPayment({
      ...prepayRequest,
      metadata: { order_id: 'forged', payment_row_id: 'row-1' },
    });
    expect(created.metadata).toEqual({
      order_id: ORDER_ID,
      order_number: 'DT-000123',
      payment_row_id: 'row-1',
    });
    const fifteen = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, 'v']));
    await expect(
      provider.createPayment({ ...prepayRequest, metadata: fifteen }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    await expect(
      provider.createPayment({ ...prepayRequest, metadata: { ['k'.repeat(33)]: 'v' } }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    await expect(
      provider.createPayment({ ...prepayRequest, metadata: { note: 'x'.repeat(513) } }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    expect(mock.requests).toHaveLength(1);
  });

  it('redirect confirmation requires returnUrl', async () => {
    await expect(
      provider.createPayment({ ...prepayRequest, returnUrl: undefined }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('Idempotence-Key stability and faults', () => {
  it('a lost response is retried with the same key: one payment in the mock', async () => {
    mock.failNext('POST /payments', 'network', { afterProcessing: true });
    const error: unknown = await provider.createPayment(prepayRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect((error as PaymentProviderError).details).toMatchObject({
      code: 'network',
      retryable: true,
    });
    expect(mock.payments.size).toBe(1);

    const retried = await provider.createPayment(prepayRequest);
    expect(mock.payments.size).toBe(1);
    expect(mock.payments.has(retried.id)).toBe(true);
    expect(mock.requests.map((r) => r.idempotenceKey)).toEqual([
      'pay-DT-000123-1',
      'pay-DT-000123-1',
    ]);
  });

  it('a 503 before processing creates nothing and is retryable', async () => {
    mock.failNext('/payments', 503);
    await expect(provider.createPayment(prepayRequest)).rejects.toMatchObject({
      details: { status: 503, retryable: true },
    });
    expect(mock.payments.size).toBe(0);
    await provider.createPayment(prepayRequest);
    expect(mock.payments.size).toBe(1);
  });

  it('HTTP 202 processing: retry later with the same key gets the payment', async () => {
    mock.processingNext('POST /payments', { afterProcessing: true, retryAfterMs: 500 });
    await expect(provider.createPayment(prepayRequest)).rejects.toMatchObject({
      details: { status: 202, code: 'processing', retryable: true, retryAfterMs: 500 },
    });
    const payment = await provider.createPayment(prepayRequest);
    expect(mock.payments.size).toBe(1);
    expect(payment.status).toBe('pending');
  });

  it('failNext matches the method and path and is consumed once', async () => {
    const created = await provider.createPayment(prepayRequest);
    mock.failNext(`GET /payments/${created.id}`, 500, { times: 2 });
    await expect(provider.getPayment(created.id)).rejects.toMatchObject({
      details: { status: 500, code: 'internal_server_error' },
    });
    await expect(provider.getPayment(created.id)).rejects.toMatchObject({
      details: { status: 500 },
    });
    await expect(provider.getPayment(created.id)).resolves.toMatchObject({ id: created.id });
  });

  it('delayMs beyond the client timeout is a retryable network error after processing', async () => {
    const slow = createYooKassaProvider({
      shopId: SHOP_ID,
      secretKey: SECRET_KEY,
      apiUrl: API,
      timeoutMs: 30,
    });
    mock.configure({ delayMs: 300 });
    await expect(slow.createPayment(prepayRequest)).rejects.toMatchObject({
      details: { code: 'network', retryable: true },
    });
    expect(mock.payments.size).toBe(1);
    mock.configure({ delayMs: 0 });
    await slow.createPayment(prepayRequest);
    expect(mock.payments.size).toBe(1);
  });
});

describe('payment states', () => {
  it('3-D Secure: pending with confirmation_url, then succeeded', async () => {
    const created = await provider.createPayment(prepayRequest);
    expect(created.confirmationUrl).toMatch(/^https:\/\/yoomoney\.ru\//);
    mock.startThreeDSecure(created.id);
    expect(await provider.getPayment(created.id)).toMatchObject({
      status: 'pending',
      paid: false,
      method: 'bank_card',
    });
    // A notification claiming success while GET still says pending is only a hint.
    const hint = provider.parseWebhook(mock.notification('payment.succeeded', created.id));
    expect(hint.objectStatus).toBe('succeeded');
    expect((await provider.getPayment(created.id)).status).toBe('pending');
    mock.setPaymentStatus(created.id, 'succeeded');
    expect((await provider.getPayment(created.id)).status).toBe('succeeded');
  });

  it('canceled payment exposes the cancellation reason', async () => {
    const created = await provider.createPayment(prepayRequest);
    mock.setPaymentStatus(created.id, 'canceled', {
      party: 'payment_network',
      reason: 'insufficient_funds',
    });
    expect(await provider.getPayment(created.id)).toMatchObject({
      status: 'canceled',
      paid: false,
      paidAt: null,
      cancellationReason: 'insufficient_funds',
      cancellationParty: 'payment_network',
    });
  });

  it('a paid amount different from the requested one is visible (amount mismatch)', async () => {
    const created = await provider.createPayment({ ...prepayRequest, receipt: null });
    mock.setPaymentStatus(created.id, 'succeeded', { amountKop: 100_000 });
    expect(await provider.getPayment(created.id)).toMatchObject({ amountKop: 100_000 });
  });

  it('a payment in another currency is a bad_response', async () => {
    server.use(
      http.get(`${API}/payments/:id`, ({ params }) =>
        HttpResponse.json({
          id: params.id,
          status: 'succeeded',
          paid: true,
          amount: { value: '100.00', currency: 'USD' },
        }),
      ),
    );
    await expect(provider.getPayment('x')).rejects.toMatchObject({
      details: { code: 'bad_response', retryable: false },
    });
  });

  it('absent optional fields become null instead of an error', async () => {
    server.use(
      http.get(`${API}/payments/:id`, ({ params }) =>
        HttpResponse.json({
          id: params.id,
          status: 'succeeded',
          paid: true,
          amount: { value: '100.00', currency: 'RUB' },
          receipt_registration: 'unknown_value',
        }),
      ),
    );
    expect(await provider.getPayment('x')).toMatchObject({
      receiptRegistration: null,
      paidAt: null,
      cancellationReason: null,
      createdAt: '',
    });
  });
});

describe('refunds with a receipt', () => {
  it('a partial refund repeats the payment_mode of the original receipt', async () => {
    const payment = await paidPrepayment();
    const refund = await provider.createRefund({
      paymentId: payment.id,
      amountKop: 64_000,
      idempotenceKey: 'refund-item-1',
      receipt: { customer: { phone: '79990000000' }, lines: [line({ quantity: 1 })] },
    });
    expect(refund).toMatchObject({
      status: 'succeeded',
      amountKop: 64_000,
      receiptRegistration: 'succeeded',
    });
    expect(mock.requests.at(-1)?.body).toMatchObject({
      receipt: { items: [{ payment_mode: 'full_prepayment', quantity: 1 }] },
    });
    expect(await provider.listRefundReceipts(refund.id)).toMatchObject([
      { type: 'refund', refundId: refund.id, status: 'succeeded', paymentMode: 'full_prepayment' },
    ]);
    expect(await provider.getPayment(payment.id)).toMatchObject({ refundedAmountKop: 64_000 });
  });

  it('rejects a refund receipt with another payment_mode, without a receipt or over the sum', async () => {
    const payment = await paidPrepayment();
    await expect(
      provider.createRefund({
        paymentId: payment.id,
        amountKop: 128_000,
        idempotenceKey: 'refund-wrong-mode',
        receipt: { customer: {}, lines: [line({ paymentMode: 'full_payment' })] },
      }),
    ).rejects.toMatchObject({ details: { status: 400, code: 'invalid_request' } });
    await expect(
      provider.createRefund({ paymentId: payment.id, amountKop: 1000, idempotenceKey: 'no-rc' }),
    ).rejects.toMatchObject({ details: { status: 400 } });
    await expect(
      provider.createRefund({
        paymentId: payment.id,
        amountKop: 192_000,
        idempotenceKey: 'refund-too-much',
        receipt: { customer: {}, lines: [line({ quantity: 3 })] },
      }),
    ).rejects.toMatchObject({ details: { status: 400, retryable: false } });
    expect(mock.refunds.size).toBe(0);
  });

  it('after the offset receipt a refund may mirror full_payment', async () => {
    const payment = await paidPrepayment();
    await provider.createOffsetReceipt({
      paymentId: payment.id,
      idempotenceKey: 'offset-1',
      customer: {},
      lines: [line({ paymentMode: 'full_payment' })],
      prepaymentKop: 128_000,
      taxSystemCode: 2,
    });
    await expect(
      provider.createRefund({
        paymentId: payment.id,
        amountKop: 128_000,
        idempotenceKey: 'refund-after-handover',
        receipt: { customer: {}, lines: [line({ paymentMode: 'full_payment' })] },
      }),
    ).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('a canceled refund carries the reason and does not count as refunded', async () => {
    mock.configure({ refundStatus: 'canceled' });
    const payment = await paidPrepayment();
    const refund = await provider.createRefund({
      paymentId: payment.id,
      amountKop: 128_000,
      idempotenceKey: 'refund-canceled',
      receipt: { customer: {}, lines: [line()] },
    });
    expect(refund).toMatchObject({ status: 'canceled', cancellationReason: 'rejected_by_payee' });
    expect((await provider.getPayment(payment.id)).refundedAmountKop).toBe(0);
  });
});

describe('POST /receipts: offset receipt and listPaymentReceipts', () => {
  it('lists the prepayment and the offset receipt of a payment', async () => {
    const payment = await paidPrepayment();
    const offset = await provider.createOffsetReceipt({
      paymentId: payment.id,
      idempotenceKey: 'offset-DT-000123',
      customer: { phone: '79990000000' },
      lines: [line({ paymentMode: 'full_payment' })],
      prepaymentKop: 128_000,
      taxSystemCode: 2,
    });
    expect(offset).toMatchObject({ paymentMode: 'full_payment', settlementTypes: ['prepayment'] });
    const receipts = await provider.listPaymentReceipts(payment.id);
    expect(receipts.map((r) => [r.paymentMode, r.settlementTypes])).toEqual([
      ['full_prepayment', ['cashless']],
      ['full_payment', ['prepayment']],
    ]);
  });

  it('rejectTaxSystemCode: POST /receipts answers 400 invalid_request, not retryable', async () => {
    mock.configure({ rejectTaxSystemCode: 2 });
    const payment = await paidPrepayment();
    const error: unknown = await provider
      .createOffsetReceipt({
        paymentId: payment.id,
        idempotenceKey: 'offset-rejected',
        customer: {},
        lines: [line({ paymentMode: 'full_payment' })],
        prepaymentKop: 128_000,
        taxSystemCode: 2,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect((error as PaymentProviderError).details).toMatchObject({
      status: 400,
      code: 'invalid_request',
      retryable: false,
    });
    // The payment's own receipt is not affected by the switch (it is not POST /receipts).
    expect(await provider.listPaymentReceipts(payment.id)).toHaveLength(1);
  });

  it('follows next_cursor and rejects a malformed list', async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/receipts`, ({ request }) => {
        calls += 1;
        const cursor = new URL(request.url).searchParams.get('cursor');
        const receipt = (id: string) => ({
          id,
          type: 'payment',
          status: 'succeeded',
          payment_id: 'p1',
          items: [{ payment_mode: 'full_prepayment' }],
        });
        return cursor === null
          ? HttpResponse.json({ type: 'list', items: [receipt('r1')], next_cursor: 'c2' })
          : HttpResponse.json({ type: 'list', items: [receipt('r2')] });
      }),
    );
    expect((await provider.listPaymentReceipts('p1')).map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(calls).toBe(2);

    server.use(http.get(`${API}/receipts`, () => HttpResponse.json({ items: 'nope' })));
    await expect(provider.listPaymentReceipts('p1')).rejects.toMatchObject({
      details: { code: 'bad_response' },
    });
  });
});

describe('listPayments for the nightly reconciliation', () => {
  it('filters by created_at window and pages with the cursor', async () => {
    let clock = Date.parse('2026-10-01T10:00:00.000Z');
    mock.configure({ now: () => new Date(clock) });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const p = await provider.createPayment({
        ...prepayRequest,
        receipt: null,
        idempotenceKey: `list-${i}`,
      });
      ids.push(p.id);
      clock += 60 * 60 * 1000; // one per hour: 10:00 … 14:00
    }
    mock.setPaymentStatus(ids[1] ?? '', 'succeeded');

    const window = {
      createdGte: '2026-10-01T11:00:00.000Z',
      createdLt: '2026-10-01T14:00:00.000Z',
      limit: 2,
    };
    const first = await provider.listPayments(window);
    expect(mock.requests.at(-1)?.query).toMatchObject({
      'created_at.gte': '2026-10-01T11:00:00.000Z',
      'created_at.lt': '2026-10-01T14:00:00.000Z',
      limit: '2',
    });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await provider.listPayments({ ...window, cursor: first.nextCursor });
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items];
    expect(all.map((p) => p.id).sort()).toEqual([ids[1], ids[2], ids[3]].sort());
    expect(all.find((p) => p.id === ids[1])).toMatchObject({ status: 'succeeded', paid: true });
  });

  it('validates the window and the page size locally', async () => {
    await expect(
      provider.listPayments({ createdGte: 'yesterday', createdLt: '2026-10-02T00:00:00Z' }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    await expect(
      provider.listPayments({
        createdGte: '2026-10-01T00:00:00Z',
        createdLt: '2026-10-02T00:00:00Z',
        limit: 101,
      }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    expect(mock.requests).toHaveLength(0);
  });
});
