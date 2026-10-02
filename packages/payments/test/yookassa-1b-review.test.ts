// Review fixes of the phase 1B adapter: errors classified for the worker's retry logic, a
// time zone-safe reconciliation window, and refund bookkeeping of the emulation.
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createYooKassaProvider, PaymentProviderError, PaymentRequestError } from '../src';
import { createYooKassaMock } from '../src/testing/yookassa-handlers';
import { API, line, prepayRequest, SECRET_KEY, SHOP_ID } from './helpers';

const mock = createYooKassaMock({ apiUrl: API, shopId: SHOP_ID, secretKey: SECRET_KEY });
const server = setupServer(...mock.handlers);

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  mock.reset();
});
afterAll(() => server.close());

const provider = createYooKassaProvider({ shopId: SHOP_ID, secretKey: SECRET_KEY, apiUrl: API });

describe('error classification', () => {
  it('a timeout while the body streams is a retryable network error', async () => {
    // Injected transport: headers and the first bytes arrive, then the body stalls until the
    // client's timeout aborts it (the way fetch fails a body read after AbortSignal fires).
    const stalledFetch: typeof fetch = (_input, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"p1",'));
          signal?.addEventListener('abort', () => controller.error(signal.reason));
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { 'Content-Type': 'application/json' } }),
      );
    };
    const slow = createYooKassaProvider({
      shopId: SHOP_ID,
      secretKey: SECRET_KEY,
      apiUrl: API,
      timeoutMs: 50,
      fetch: stalledFetch,
    });
    const error = await slow.getPayment('p1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ details: { code: 'network', retryable: true } });
    expect((error as Error).message).toContain('TimeoutError');
  });

  it.each(['-1.00', '1.005', '1e3', ''])(
    'a malformed amount %j from the provider is a bad_response',
    async (value) => {
      server.use(
        http.get(`${API}/payments/:id`, ({ params }) =>
          HttpResponse.json({
            id: params.id,
            status: 'succeeded',
            paid: true,
            amount: { value, currency: 'RUB' },
          }),
        ),
      );
      const error = await provider.getPayment('x').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PaymentProviderError);
      expect(error).toMatchObject({ details: { code: 'bad_response', retryable: false } });
    },
  );

  it('a zero or fractional amount is rejected locally, before any request', async () => {
    await expect(
      provider.createPayment({ ...prepayRequest, amountKop: 0, receipt: null }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    await expect(
      provider.createRefund({ paymentId: 'p', amountKop: 0, idempotenceKey: 'r0' }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    await expect(
      provider.createRefund({ paymentId: 'p', amountKop: 10.5, idempotenceKey: 'r1' }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('listPayments window', () => {
  it('requires an explicit time zone: a bare local time would shift the window', async () => {
    await expect(
      provider.listPayments({
        createdGte: '2026-10-01T00:00:00',
        createdLt: '2026-10-02T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    await expect(
      provider.listPayments({ createdGte: '2026-10-01', createdLt: '2026-10-02T00:00:00Z' }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    expect(mock.requests).toHaveLength(0);
  });

  it('converts an offset to UTC (a Yekaterinburg day) and rejects an empty window', async () => {
    await provider.listPayments({
      createdGte: '2026-10-01T00:00:00+05:00',
      createdLt: '2026-10-02T00:00:00+05:00',
    });
    expect(mock.requests.at(-1)?.query).toMatchObject({
      'created_at.gte': '2026-09-30T19:00:00.000Z',
      'created_at.lt': '2026-10-01T19:00:00.000Z',
    });
    await expect(
      provider.listPayments({
        createdGte: '2026-10-02T00:00:00Z',
        createdLt: '2026-10-02T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
  });
});

describe('emulation: refund bookkeeping', () => {
  it('a pending refund that is later canceled frees the amount for a new refund', async () => {
    mock.configure({ refundStatus: 'pending' });
    const payment = await provider.createPayment(prepayRequest);
    mock.setPaymentStatus(payment.id, 'succeeded');
    const refund = await provider.createRefund({
      paymentId: payment.id,
      amountKop: 128_000,
      idempotenceKey: 'refund-1',
      receipt: { customer: {}, lines: [line()] },
    });
    expect(refund.status).toBe('pending');
    mock.setRefundStatus(refund.id, 'canceled');
    expect(await provider.getRefund(refund.id)).toMatchObject({
      status: 'canceled',
      cancellationReason: 'rejected_by_payee',
    });
    expect((await provider.getPayment(payment.id)).refundedAmountKop).toBe(0);

    mock.configure({ refundStatus: 'succeeded' });
    const retry = await provider.createRefund({
      paymentId: payment.id,
      amountKop: 128_000,
      idempotenceKey: 'refund-2',
      receipt: { customer: {}, lines: [line()] },
    });
    expect(retry.status).toBe('succeeded');
    expect((await provider.getPayment(payment.id)).refundedAmountKop).toBe(128_000);
  });
});
