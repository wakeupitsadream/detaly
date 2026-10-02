// parseWebhook on notifications in the form the emulation produces (= the real form:
// {type: 'notification', event, object: <full object>}), and on garbage.
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createYooKassaProvider, WEBHOOK_EVENTS, webhookJobId, WebhookParseError } from '../src';
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

describe('parseWebhook on the four events', () => {
  it('covers exactly the four supported events', () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual([
      'payment.canceled',
      'payment.succeeded',
      'payment.waiting_for_capture',
      'refund.succeeded',
    ]);
  });

  it.each([
    ['payment.succeeded', 'succeeded'],
    ['payment.waiting_for_capture', 'waiting_for_capture'],
    ['payment.canceled', 'canceled'],
  ] as const)('%s', async (event, status) => {
    const payment = await provider.createPayment(prepayRequest);
    const body = mock.notification(event, payment.id);
    expect(body).toMatchObject({
      type: 'notification',
      event,
      object: { id: payment.id, status, amount: { value: '1280.00', currency: 'RUB' } },
    });
    const parsed = provider.parseWebhook(JSON.parse(JSON.stringify(body)));
    expect(parsed).toMatchObject({
      event,
      objectType: 'payment',
      objectId: payment.id,
      objectStatus: status,
    });
    expect(webhookJobId(parsed)).toBe(`${event}:${payment.id}`);
  });

  it('refund.succeeded', async () => {
    const payment = await provider.createPayment(prepayRequest);
    mock.setPaymentStatus(payment.id, 'succeeded');
    const refund = await provider.createRefund({
      paymentId: payment.id,
      amountKop: 128_000,
      idempotenceKey: 'refund-1',
      receipt: { customer: {}, lines: [line()] },
    });
    const parsed = provider.parseWebhook(mock.notification('refund.succeeded', refund.id));
    expect(parsed).toMatchObject({
      event: 'refund.succeeded',
      objectType: 'refund',
      objectId: refund.id,
      objectStatus: 'succeeded',
    });
    expect((parsed.raw as { object: { payment_id: string } }).object.payment_id).toBe(payment.id);
  });

  it('the notification is a snapshot: later changes of the store do not leak into it', async () => {
    const payment = await provider.createPayment(prepayRequest);
    const body = mock.notification('payment.canceled', payment.id, {
      cancellation_details: { party: 'merchant', reason: 'canceled_by_merchant' },
    });
    mock.setPaymentStatus(payment.id, 'succeeded');
    expect(body).toMatchObject({
      object: { status: 'canceled', cancellation_details: { reason: 'canceled_by_merchant' } },
    });
    expect(mock.payments.get(payment.id)?.status).toBe('succeeded');
  });
});

describe('parseWebhook rejects garbage', () => {
  it.each([
    undefined,
    null,
    42,
    'payment.succeeded',
    [],
    {},
    { type: 'notification' },
    { type: 'notification', event: 'payment.succeeded' },
    { type: 'notification', event: 'payment.succeeded', object: null },
    { type: 'notification', event: 'payment.succeeded', object: 'id' },
    { type: 'notification', event: 'payment.succeeded', object: { id: 42 } },
    { type: 'notification', event: 'refund.canceled', object: { id: 'r1' } },
    { type: 'notification', event: 'deal.closed', object: { id: 'd1' } },
    { type: 'Notification', event: 'payment.succeeded', object: { id: 'p1' } },
    { event: 'payment.succeeded', object: { id: 'p1' } },
  ])('%j', (body) => {
    expect(() => provider.parseWebhook(body)).toThrow(WebhookParseError);
  });
});
