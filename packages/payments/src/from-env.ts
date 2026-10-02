/**
 * Provider factory from the parsed env (decision Б6). Online payment is enabled only when the
 * shop credentials and both receipt codes are set: a payment is never created without a
 * receipt (54-FZ), so without YOOKASSA_VAT_CODE / YOOKASSA_TAX_SYSTEM_CODE there is no payment
 * either and /o/<token> keeps the phase 1A text «Оплата подключается».
 */
import type { Env } from '@detaly/config';
import type { PaymentProvider } from './payment-provider';
import type { ReceiptProvider } from './receipt-provider';
import { createYooKassaProvider, type YooKassaOptions } from './yookassa';

/** The env keys the factory reads (all of them come from packages/config). */
export type PaymentsEnv = Pick<
  Env,
  | 'YOOKASSA_SHOP_ID'
  | 'YOOKASSA_SECRET_KEY'
  | 'YOOKASSA_API_URL'
  | 'YOOKASSA_VAT_CODE'
  | 'YOOKASSA_TAX_SYSTEM_CODE'
>;

export interface Payments {
  payments: PaymentProvider;
  /** Plan A: the same YooKassa adapter («Чеки от ЮKassa»); plan B swaps in a cloud KKT. */
  receipts: ReceiptProvider;
}

/** True when the four variables of decision Б6 are set. */
export function paymentsEnabled(env: PaymentsEnv): boolean {
  return (
    env.YOOKASSA_SHOP_ID !== undefined &&
    env.YOOKASSA_SECRET_KEY !== undefined &&
    env.YOOKASSA_VAT_CODE !== undefined &&
    env.YOOKASSA_TAX_SYSTEM_CODE !== undefined
  );
}

/**
 * `{payments, receipts}` over YooKassa, or null when payments are disabled (decision Б6).
 * `options` overrides transport details for tests (fetch, timeout).
 */
export function createPaymentsFromEnv(
  env: PaymentsEnv,
  options: Pick<YooKassaOptions, 'fetch' | 'timeoutMs'> = {},
): Payments | null {
  const shopId = env.YOOKASSA_SHOP_ID;
  const secretKey = env.YOOKASSA_SECRET_KEY;
  if (!paymentsEnabled(env) || shopId === undefined || secretKey === undefined) return null;
  const provider = createYooKassaProvider({
    shopId,
    secretKey,
    apiUrl: env.YOOKASSA_API_URL,
    ...options,
  });
  return { payments: provider, receipts: provider };
}
