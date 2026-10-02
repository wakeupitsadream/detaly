import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPaymentsFromEnv, paymentsEnabled, type PaymentsEnv } from '../src';
import { createYooKassaMock } from '../src/testing/yookassa-handlers';
import { prepayRequest } from './helpers';

const STAGE_API = 'https://yookassa.stage.test/v3';
const mock = createYooKassaMock({ apiUrl: STAGE_API, shopId: '42', secretKey: 'stage_secret' });
const server = setupServer(...mock.handlers);

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  mock.reset();
});
afterAll(() => server.close());

const full: PaymentsEnv = {
  YOOKASSA_SHOP_ID: '42',
  YOOKASSA_SECRET_KEY: 'stage_secret',
  YOOKASSA_API_URL: STAGE_API,
  YOOKASSA_VAT_CODE: 1,
  YOOKASSA_TAX_SYSTEM_CODE: 2,
};

describe('createPaymentsFromEnv (decision Б6)', () => {
  it.each([
    'YOOKASSA_SHOP_ID',
    'YOOKASSA_SECRET_KEY',
    'YOOKASSA_VAT_CODE',
    'YOOKASSA_TAX_SYSTEM_CODE',
  ] as const)('without %s payments are disabled', (key) => {
    const env = { ...full, [key]: undefined };
    expect(paymentsEnabled(env)).toBe(false);
    expect(createPaymentsFromEnv(env)).toBeNull();
  });

  it('with all four variables returns both providers over YOOKASSA_API_URL', async () => {
    expect(paymentsEnabled(full)).toBe(true);
    const created = createPaymentsFromEnv(full);
    expect(created).not.toBeNull();
    const { payments, receipts } = created ?? {};
    expect(payments?.name).toBe('yookassa');
    expect(receipts?.name).toBe('yookassa');

    const payment = await payments?.createPayment(prepayRequest);
    expect(payment?.status).toBe('pending');
    expect(mock.requests[0]?.authorization).toBe(
      `Basic ${Buffer.from('42:stage_secret').toString('base64')}`,
    );
    expect(await receipts?.listPaymentReceipts(payment?.id ?? '')).toEqual([]);
  });

  it('passes the transport options through', async () => {
    const created = createPaymentsFromEnv(full, { timeoutMs: 20 });
    mock.configure({ delayMs: 200 });
    await expect(created?.payments.getPayment('x')).rejects.toMatchObject({
      details: { code: 'network', retryable: true },
    });
  });
});
