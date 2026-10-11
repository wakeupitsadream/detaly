import type { ReceiptLine } from '../src';

export const API = 'https://api.yookassa.ru/v3';
export const SHOP_ID = '123456';
export const SECRET_KEY = 'test_secret';

export const line = (over: Partial<ReceiptLine> = {}): ReceiptLine => ({
  description: 'MANN W 914/2 Фильтр масляный',
  quantity: 2,
  measure: 'piece',
  unitPriceKop: 64_000,
  vatCode: 1,
  paymentSubject: 'commodity',
  paymentMode: 'full_prepayment',
  ...over,
});

export const ORDER_ID = '0192f0c4-0000-7000-8000-000000000001';

/** Prepay payment of 1 280 ₽ with a full_prepayment receipt. */
export const prepayRequest = {
  orderId: ORDER_ID,
  orderNumber: 'DT-000123',
  amountKop: 128_000,
  idempotenceKey: 'pay-DT-000123-1',
  returnUrl: 'https://example.test/o/token?paid=1',
  receipt: { customer: { phone: '79990000000' }, lines: [line()], taxSystemCode: 2 },
};
