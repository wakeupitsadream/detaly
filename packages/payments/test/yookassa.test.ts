import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createYooKassaProvider,
  PaymentProviderError,
  type ReceiptLine,
  webhookJobId,
  WebhookParseError,
} from '../src';
import { createYooKassaMock } from '../src/testing/yookassa-handlers';

const API = 'https://api.yookassa.ru/v3';
const mock = createYooKassaMock({ apiUrl: API, shopId: '123456', secretKey: 'test_secret' });
const server = setupServer(...mock.handlers);

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  mock.reset();
});
afterAll(() => server.close());

const provider = createYooKassaProvider({
  shopId: '123456',
  secretKey: 'test_secret',
  apiUrl: API,
});

const line = (over: Partial<ReceiptLine> = {}): ReceiptLine => ({
  description: 'MANN W 914/2 Фильтр масляный',
  quantity: 2,
  unitPriceKop: 64_000,
  vatCode: 1,
  paymentSubject: 'commodity',
  paymentMode: 'full_prepayment',
  ...over,
});

const paymentRequest = {
  orderId: '0192f0c4-0000-7000-8000-000000000001',
  orderNumber: 'DT-000123',
  amountKop: 128_000,
  idempotenceKey: 'pay-DT-000123-1',
  returnUrl: 'https://example.test/o/token',
  receipt: { customer: { phone: '79990000000' }, lines: [line()], taxSystemCode: 2 },
};

async function succeededPayment(amountKop = 128_000) {
  const payment = await provider.createPayment({
    ...paymentRequest,
    amountKop,
    receipt: null,
    idempotenceKey: `pay-${amountKop}`,
  });
  mock.setPaymentStatus(payment.id, 'succeeded');
  return payment;
}

describe('msw handlers answer raw requests', () => {
  const auth = `Basic ${Buffer.from('123456:test_secret').toString('base64')}`;

  it('POST /v3/payments', async () => {
    const res = await fetch(`${API}/payments`, {
      method: 'POST',
      headers: { Authorization: auth, 'Idempotence-Key': 'k1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: { value: '100.00', currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: 'https://example.test' },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'pending', paid: false });
  });

  it('POST /v3/receipts', async () => {
    const payment = await succeededPayment(10_000);
    const res = await fetch(`${API}/receipts`, {
      method: 'POST',
      headers: { Authorization: auth, 'Idempotence-Key': 'r1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'payment',
        payment_id: payment.id,
        send: true,
        customer: { phone: '79990000000' },
        items: [
          {
            description: 'Деталь',
            quantity: 1,
            amount: { value: '100.00', currency: 'RUB' },
            vat_code: 1,
            payment_subject: 'commodity',
            payment_mode: 'full_payment',
          },
        ],
        settlements: [{ type: 'prepayment', amount: { value: '100.00', currency: 'RUB' } }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ type: 'payment', status: 'pending' });
  });

  it('rejects requests without Basic auth or Idempotence-Key', async () => {
    const noAuth = await fetch(`${API}/payments/x`);
    expect(noAuth.status).toBe(401);
    const noKey = await fetch(`${API}/payments`, {
      method: 'POST',
      headers: { Authorization: auth },
      body: '{}',
    });
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({
      code: 'invalid_request',
      parameter: 'Idempotence-Key',
    });
  });
});

describe('YooKassa provider: payments', () => {
  it('creates a payment with Basic auth, Idempotence-Key and receipt', async () => {
    const payment = await provider.createPayment(paymentRequest);
    expect(payment).toMatchObject({
      status: 'pending',
      paid: false,
      amountKop: 128_000,
      metadata: { order_id: paymentRequest.orderId, order_number: 'DT-000123' },
    });
    expect(payment.confirmationUrl).toMatch(/^https:\/\/yoomoney\.ru\//);
    const [request] = mock.requests;
    expect(request).toMatchObject({
      method: 'POST',
      path: '/payments',
      idempotenceKey: 'pay-DT-000123-1',
      authorization: `Basic ${Buffer.from('123456:test_secret').toString('base64')}`,
    });
    expect(request?.body).toMatchObject({
      amount: { value: '1280.00', currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: 'https://example.test/o/token' },
      description: 'Заказ DT-000123',
      receipt: {
        customer: { phone: '79990000000' },
        tax_system_code: 2,
        items: [
          {
            description: 'MANN W 914/2 Фильтр масляный',
            quantity: 2,
            amount: { value: '640.00', currency: 'RUB' },
            vat_code: 1,
            payment_subject: 'commodity',
            payment_mode: 'full_prepayment',
          },
        ],
      },
    });
  });

  it('the same Idempotence-Key returns the same payment (stable key, no double charge)', async () => {
    const first = await provider.createPayment(paymentRequest);
    const second = await provider.createPayment(paymentRequest);
    expect(second.id).toBe(first.id);
    expect(mock.payments.size).toBe(1);
    expect(mock.requests.map((r) => r.idempotenceKey)).toEqual([
      'pay-DT-000123-1',
      'pay-DT-000123-1',
    ]);
  });

  it('a reused key with other parameters is rejected', async () => {
    await provider.createPayment(paymentRequest);
    await expect(
      provider.createPayment({ ...paymentRequest, amountKop: 64_000, receipt: null }),
    ).rejects.toMatchObject({ details: { status: 400, retryable: false } });
  });

  it('QR confirmation for payment at the pickup point', async () => {
    const payment = await provider.createPayment({
      ...paymentRequest,
      confirmation: 'qr',
      idempotenceKey: 'qr-1',
      receipt: { ...paymentRequest.receipt, lines: [line({ paymentMode: 'full_payment' })] },
    });
    expect(payment.confirmationData).toMatch(/^https:\/\/qr\.nspk\.ru\//);
    expect(payment.confirmationUrl).toBeNull();
  });

  it('re-reads the payment: GET is the source of truth', async () => {
    const created = await provider.createPayment(paymentRequest);
    mock.setPaymentStatus(created.id, 'succeeded');
    const payment = await provider.getPayment(created.id);
    expect(payment).toMatchObject({
      id: created.id,
      status: 'succeeded',
      paid: true,
      method: 'bank_card',
    });
  });

  it('refuses to send a receipt that does not sum to the amount', async () => {
    await expect(provider.createPayment({ ...paymentRequest, amountKop: 128_100 })).rejects.toThrow(
      /lines sum/,
    );
    expect(mock.requests).toHaveLength(0);
  });

  it('maps HTTP errors to PaymentProviderError with retryability', async () => {
    await expect(provider.getPayment('missing')).rejects.toMatchObject({
      details: { status: 404, code: 'not_found', retryable: false },
    });
    const wrong = createYooKassaProvider({ shopId: '1', secretKey: 'bad', apiUrl: API });
    await expect(wrong.getPayment('x')).rejects.toMatchObject({ details: { status: 401 } });
    server.use(
      http.get(`${API}/payments/:id`, () =>
        HttpResponse.json({ type: 'error', code: 'internal_server_error' }, { status: 500 }),
      ),
    );
    const error: unknown = await provider.getPayment('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect((error as PaymentProviderError).details).toMatchObject({ status: 500, retryable: true });
  });

  it('HTTP 202 "processing" is a retryable error, not a malformed payment', async () => {
    server.use(
      http.post(`${API}/payments`, () =>
        HttpResponse.json({ type: 'processing', retry_after: 1800 }, { status: 202 }),
      ),
    );
    await expect(provider.createPayment(paymentRequest)).rejects.toMatchObject({
      details: { status: 202, code: 'processing', retryable: true, retryAfterMs: 1800 },
    });
  });

  it('network failures are retryable', async () => {
    server.use(http.get(`${API}/payments/:id`, () => HttpResponse.error()));
    await expect(provider.getPayment('x')).rejects.toMatchObject({
      details: { code: 'network', retryable: true },
    });
  });

  it('rejects malformed provider answers', async () => {
    server.use(
      http.get(`${API}/payments/:id`, () => HttpResponse.json({ id: 'x', status: 'weird' })),
    );
    await expect(provider.getPayment('x')).rejects.toMatchObject({
      details: { code: 'bad_response' },
    });
  });
});

describe('YooKassa provider: refunds', () => {
  it('full and partial refunds up to the paid amount', async () => {
    const payment = await succeededPayment(128_000);
    const partial = await provider.createRefund({
      paymentId: payment.id,
      amountKop: 64_000,
      idempotenceKey: 'refund-1',
      receipt: {
        customer: { phone: '79990000000' },
        lines: [line({ quantity: 1 })],
      },
    });
    expect(partial).toMatchObject({
      paymentId: payment.id,
      status: 'succeeded',
      amountKop: 64_000,
    });
    expect(mock.requests.at(-1)?.body).toMatchObject({
      payment_id: payment.id,
      amount: { value: '640.00', currency: 'RUB' },
      receipt: { items: [{ payment_mode: 'full_prepayment', quantity: 1 }] },
    });
    await expect(
      provider.createRefund({
        paymentId: payment.id,
        amountKop: 64_100,
        idempotenceKey: 'refund-2',
      }),
    ).rejects.toMatchObject({ details: { status: 400 } });
    const rest = await provider.createRefund({
      paymentId: payment.id,
      amountKop: 64_000,
      idempotenceKey: 'refund-3',
    });
    expect(await provider.getRefund(rest.id)).toMatchObject({
      status: 'succeeded',
      amountKop: 64_000,
    });
  });

  it('a refund of an unpaid payment is rejected', async () => {
    const payment = await provider.createPayment({ ...paymentRequest, receipt: null });
    await expect(
      provider.createRefund({ paymentId: payment.id, amountKop: 100, idempotenceKey: 'r' }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
  });
});

describe('YooKassa provider: offset receipt (ReceiptProvider)', () => {
  it('POST /receipts with settlements prepayment, then polls until succeeded', async () => {
    const payment = await succeededPayment(128_000);
    const receipt = await provider.createOffsetReceipt({
      paymentId: payment.id,
      idempotenceKey: 'offset-DT-000123',
      customer: { phone: '79990000000' },
      lines: [line({ paymentMode: 'full_payment' })],
      prepaymentKop: 128_000,
      taxSystemCode: 2,
    });
    expect(receipt).toMatchObject({ type: 'payment', status: 'pending', paymentId: payment.id });
    expect(mock.requests.at(-1)?.body).toMatchObject({
      type: 'payment',
      payment_id: payment.id,
      send: true,
      tax_system_code: 2,
      items: [{ payment_mode: 'full_payment', payment_subject: 'commodity' }],
      settlements: [{ type: 'prepayment', amount: { value: '1280.00', currency: 'RUB' } }],
    });

    // retry with the same key does not create a second receipt
    await provider.createOffsetReceipt({
      paymentId: payment.id,
      idempotenceKey: 'offset-DT-000123',
      customer: { phone: '79990000000' },
      lines: [line({ paymentMode: 'full_payment' })],
      prepaymentKop: 128_000,
      taxSystemCode: 2,
    });
    expect(mock.receipts.size).toBe(1);

    mock.setReceiptStatus(receipt.id, 'succeeded');
    expect(await provider.getReceipt(receipt.id)).toMatchObject({
      status: 'succeeded',
      fiscalDocumentNumber: '3986',
    });
  });

  it('offset receipt lines must be full_payment and sum to the prepayment', async () => {
    const base = {
      paymentId: 'p',
      idempotenceKey: 'k',
      customer: {},
      prepaymentKop: 128_000,
    };
    await expect(provider.createOffsetReceipt({ ...base, lines: [line()] })).rejects.toThrow(
      /payment_mode/,
    );
    await expect(
      provider.createOffsetReceipt({
        ...base,
        lines: [line({ paymentMode: 'full_payment', quantity: 1 })],
      }),
    ).rejects.toThrow(/lines sum/);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('webhooks', () => {
  it('parses YooKassa notifications', async () => {
    const payment = await succeededPayment();
    const parsed = provider.parseWebhook(mock.notification('payment.succeeded', payment.id));
    expect(parsed).toMatchObject({
      event: 'payment.succeeded',
      objectType: 'payment',
      objectId: payment.id,
      objectStatus: 'succeeded',
    });
    expect(webhookJobId(parsed)).toBe(`payment.succeeded:${payment.id}`);
    expect(
      provider.parseWebhook({
        type: 'notification',
        event: 'refund.succeeded',
        object: { id: 'r1' },
      }),
    ).toMatchObject({
      objectType: 'refund',
      objectId: 'r1',
      objectStatus: null,
    });
  });

  it.each([
    null,
    'text',
    { type: 'other', event: 'payment.succeeded', object: { id: 'x' } },
    { type: 'notification', event: 'payment.unknown', object: { id: 'x' } },
    { type: 'notification', event: 'payment.canceled', object: {} },
    { type: 'notification', event: 'payment.canceled', object: { id: '' } },
  ])('rejects %j', (body) => {
    expect(() => provider.parseWebhook(body)).toThrow(WebhookParseError);
  });
});
