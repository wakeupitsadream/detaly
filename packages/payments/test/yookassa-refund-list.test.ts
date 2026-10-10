// Step 7 (docs/month-close.md): GET /refunds for the month reconciliation of /admin/month — the
// created_at window, cursor paging, the parsed refund objects and local validation; against the
// msw emulation only (VERIFY: the list format of the real API).
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createYooKassaProvider,
  PaymentProviderError,
  PaymentRequestError,
  type ProviderRefund,
} from '../src';
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

/** A paid payment of 1 280 ₽ and `count` refunds of 100 ₽, one per hour from `from`. */
async function refundsFrom(from: string, count: number): Promise<ProviderRefund[]> {
  let clock = Date.parse(from);
  mock.configure({ now: () => new Date(clock) });
  const payment = await provider.createPayment({ ...prepayRequest, idempotenceKey: `p-${from}` });
  mock.setPaymentStatus(payment.id, 'succeeded');
  const out: ProviderRefund[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      await provider.createRefund({
        paymentId: payment.id,
        amountKop: 10_000,
        idempotenceKey: `r-${from}-${i}`,
        receipt: {
          customer: { phone: '79990000000' },
          lines: [line({ quantity: 1, unitPriceKop: 10_000 })],
          taxSystemCode: 2,
        },
      }),
    );
    clock += 60 * 60 * 1000;
  }
  return out;
}

describe('listRefunds for the month reconciliation', () => {
  it('filters by the created_at window and pages with the cursor', async () => {
    const made = await refundsFrom('2026-09-30T17:00:00.000Z', 5); // 17:00 … 21:00 UTC
    // September in Orenburg ends at 19:00 UTC: the window [19:00, 22:00) holds three refunds.
    const window = {
      createdGte: '2026-09-30T19:00:00.000Z',
      createdLt: '2026-09-30T22:00:00.000Z',
      limit: 2,
    };
    const first = await provider.listRefunds(window);
    expect(mock.requests.at(-1)).toMatchObject({
      method: 'GET',
      path: '/refunds',
      query: {
        'created_at.gte': '2026-09-30T19:00:00.000Z',
        'created_at.lt': '2026-09-30T22:00:00.000Z',
        limit: '2',
      },
    });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await provider.listRefunds({ ...window, cursor: first.nextCursor });
    expect(mock.requests.at(-1)?.query.cursor).toBe(first.nextCursor);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const listed = [...first.items, ...second.items];
    expect(listed.map((r) => r.id).sort()).toEqual([made[2]?.id, made[3]?.id, made[4]?.id].sort());
    expect(listed[0]).toMatchObject({
      status: 'succeeded',
      amountKop: 10_000,
      paymentId: made[0]?.paymentId,
    });
  });

  it('an empty window is one page without a cursor', async () => {
    await refundsFrom('2026-09-10T10:00:00.000Z', 1);
    const page = await provider.listRefunds({
      createdGte: '2026-08-31T19:00:00.000Z',
      createdLt: '2026-09-01T19:00:00.000Z',
    });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(mock.requests.at(-1)?.query.limit).toBe('100');
  });

  it('validates the window and the page size locally, without a request', async () => {
    await expect(
      provider.listRefunds({ createdGte: '2026-10-01', createdLt: '2026-10-02T00:00:00Z' }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    await expect(
      provider.listRefunds({
        createdGte: '2026-10-02T00:00:00Z',
        createdLt: '2026-10-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    await expect(
      provider.listRefunds({
        createdGte: '2026-10-01T00:00:00Z',
        createdLt: '2026-10-02T00:00:00Z',
        limit: 0,
      }),
    ).rejects.toBeInstanceOf(PaymentRequestError);
    expect(mock.requests).toHaveLength(0);
  });

  it('a provider error or a malformed list is a PaymentProviderError', async () => {
    mock.failNext('GET /refunds', 500);
    const window = { createdGte: '2026-10-01T00:00:00Z', createdLt: '2026-10-02T00:00:00Z' };
    await expect(provider.listRefunds(window)).rejects.toMatchObject({
      name: 'PaymentProviderError',
      details: { status: 500, retryable: true },
    });
    server.use(http.get(`${API}/refunds`, () => HttpResponse.json({ type: 'list', items: 'x' })));
    const error = await provider.listRefunds(window).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({ details: { code: 'bad_response' } });
  });
});
