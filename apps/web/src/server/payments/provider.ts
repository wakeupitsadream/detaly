/**
 * The payment provider of web (decision Б6): YooKassa when the shop credentials and both
 * receipt codes are set, otherwise null («Оплата подключается» on /o/<token>). Web calls the
 * provider only to create an online payment after the client's click (decision Б5); everything
 * else (webhooks, receipts, refunds) is the worker's.
 */
import { createPaymentsFromEnv, type Payments } from '@detaly/payments';
import { serverEnv } from '../env';
import { singleton } from '../globals';

/** POST /payments timeout of the pay button (section 14.1). */
export const PAY_TIMEOUT_MS = 15_000;

export function getPayments(): Payments | null {
  return singleton('payments', () =>
    createPaymentsFromEnv(serverEnv(), { timeoutMs: PAY_TIMEOUT_MS }),
  );
}
