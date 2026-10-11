/**
 * Audit legal-3: FFD 1.2 makes the measure of quantity (tag 2108) mandatory in every receipt
 * item. Every receipt kind is built by the domain builders and sent through the YooKassa adapter
 * to the emulation, which answers 400 to an item without `measure` (as an FFD 1.2 kassa does);
 * every item that leaves for YooKassa must say 'piece'.
 */
import {
  buildOffsetReceipt,
  buildPaymentReceipt,
  buildRefundReceipt,
  planItemRefund,
  planOrderRefund,
  type ReceiptItemInput,
  type RefundPlan,
} from '@detaly/domain';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createYooKassaProvider,
  PaymentProviderError,
  RECEIPT_ITEM_MEASURE,
  type ProviderPayment,
  type ReceiptLine,
} from '../src';
import { createYooKassaMock, type RecordedRequest } from '../src/testing/yookassa-handlers';
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

const CODES = { phone: '+79990000000', vatCode: 1, taxSystemCode: 2 } as const;
const filter: ReceiptItemInput = {
  orderItemId: 'item-filter',
  brand: 'MANN-FILTER',
  article: 'W 914/2',
  name: 'Фильтр масляный',
  qty: 2,
  priceClientKop: 64_000,
  refundedAmountKop: 0,
  state: 'arrived',
};
const pads: ReceiptItemInput = {
  orderItemId: 'item-pads',
  brand: 'BOSCH',
  article: '0 986 494 524',
  name: 'Колодки тормозные передние',
  qty: 1,
  priceClientKop: 315_000,
  refundedAmountKop: 0,
  state: 'arrived',
};
const ITEMS = [filter, pads];

interface Sent {
  /** Lines of the receipt as the domain built them. */
  lines: readonly ReceiptLine[];
  /** Where the receipt went: inside POST /payments or POST /refunds, or as POST /receipts. */
  endpoint: '/payments' | '/refunds' | '/receipts';
}

/** A succeeded payment of the order with its own receipt (online prepayment or QR at handover). */
async function paid(
  kind: 'prepayment' | 'full',
  courierFeeKop: number,
): Promise<{ payment: ProviderPayment; lines: readonly ReceiptLine[] }> {
  const { data, amountKop } = buildPaymentReceipt({ ...CODES, kind, items: ITEMS, courierFeeKop });
  const payment = await provider.createPayment({
    orderId: ORDER_ID,
    orderNumber: 'DT-000123',
    amountKop,
    idempotenceKey: `pay-${kind}-${courierFeeKop}`,
    ...(kind === 'full'
      ? { confirmation: 'qr' as const }
      : { returnUrl: 'https://example.test/o/token?paid=1' }),
    receipt: data,
  });
  mock.setPaymentStatus(payment.id, 'succeeded');
  return { payment, lines: data.lines };
}

/** POST /refunds of a refund plan with the refund receipt of `kind`. */
async function refund(
  payment: ProviderPayment,
  kind: 'refund_prepayment' | 'refund_full',
  plan: RefundPlan,
): Promise<Sent> {
  const { data, amountKop } = buildRefundReceipt({ ...CODES, kind, lines: plan.lines });
  await provider.createRefund({
    paymentId: payment.id,
    amountKop,
    idempotenceKey: `refund-${payment.id}`,
    receipt: data,
  });
  return { lines: data.lines, endpoint: '/refunds' };
}

/** Whole-order refund plan of a payment. */
const orderRefund = (payment: ProviderPayment, courierFeeKop: number): RefundPlan =>
  planOrderRefund({ items: ITEMS, courierFeeKop, paymentKop: payment.amountKop, refunds: [] });

/** [receipt kind, carries the delivery line of an order that has one, how it is sent]. */
const KINDS: [string, boolean, (courierFeeKop: number) => Promise<Sent>][] = [
  [
    'prepayment',
    true,
    async (fee) => ({ lines: (await paid('prepayment', fee)).lines, endpoint: '/payments' }),
  ],
  [
    'full',
    true,
    async (fee) => ({ lines: (await paid('full', fee)).lines, endpoint: '/payments' }),
  ],
  [
    'offset',
    true,
    async (fee) => {
      const { payment } = await paid('prepayment', fee);
      const { data, prepaymentKop } = buildOffsetReceipt({
        ...CODES,
        items: ITEMS,
        courierFeeKop: fee,
      });
      await provider.createOffsetReceipt({
        paymentId: payment.id,
        idempotenceKey: `offset-${payment.id}`,
        customer: data.customer,
        lines: data.lines,
        prepaymentKop,
        taxSystemCode: data.taxSystemCode,
      });
      return { lines: data.lines, endpoint: '/receipts' };
    },
  ],
  [
    'refund_prepayment',
    true,
    async (fee) => {
      const { payment } = await paid('prepayment', fee);
      return refund(payment, 'refund_prepayment', orderRefund(payment, fee));
    },
  ],
  [
    'refund_full',
    true,
    async (fee) => {
      const { payment } = await paid('full', fee);
      return refund(payment, 'refund_full', orderRefund(payment, fee));
    },
  ],
  [
    'partial refund by line',
    false,
    async (fee) => {
      const { payment } = await paid('prepayment', fee);
      const plan = planItemRefund({ item: pads, refunds: [], paymentKop: payment.amountKop });
      return refund(payment, 'refund_prepayment', plan);
    },
  ],
];

/** Receipt items of a recorded request: POST /receipts carries them at the top level. */
function wireItems(request: RecordedRequest | undefined): Record<string, unknown>[] {
  const receipt = request?.path === '/receipts' ? request.body : request?.body?.receipt;
  return (receipt as { items?: Record<string, unknown>[] } | undefined)?.items ?? [];
}

it('the measure of every receipt line is the piece (tag 2108 = 0)', () => {
  expect(RECEIPT_ITEM_MEASURE).toBe('piece');
});

describe.each([
  ['without the delivery line', 0],
  ['with the delivery line', 30_000],
])('every receipt kind, %s: measure = piece on every item sent', (_label, courierFeeKop) => {
  it.each(KINDS)('%s', async (_kind, carriesDelivery, send) => {
    const { lines, endpoint } = await send(courierFeeKop);
    const request = mock.requests.filter((r) => r.method === 'POST' && r.path === endpoint).at(-1);
    const items = wireItems(request);
    expect(items.length).toBeGreaterThan(0);
    expect(items).toHaveLength(lines.length);
    expect(lines.every((l) => l.measure === 'piece')).toBe(true);
    expect(items.every((item) => item.measure === 'piece')).toBe(true);
    const services = items.filter((item) => item.payment_subject === 'service');
    expect(services).toHaveLength(carriesDelivery && courierFeeKop > 0 ? 1 : 0);
  });
});

describe('the emulation answers 400 to an item without measure, as an FFD 1.2 kassa does', () => {
  /** A line of a receipt builder that forgot the measure. */
  function forgotten(over: Partial<ReceiptLine> = {}): ReceiptLine {
    const { measure: _measure, ...rest } = line(over);
    return rest as ReceiptLine;
  }

  it('POST /payments: nothing is created', async () => {
    const error: unknown = await provider
      .createPayment({
        ...prepayRequest,
        receipt: { ...prepayRequest.receipt, lines: [forgotten()] },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect((error as PaymentProviderError).details).toMatchObject({
      status: 400,
      code: 'invalid_request',
      retryable: false,
    });
    expect(mock.payments.size).toBe(0);
  });

  it('POST /refunds and POST /receipts: nothing is refunded or registered', async () => {
    const payment = await provider.createPayment(prepayRequest);
    mock.setPaymentStatus(payment.id, 'succeeded');
    const receiptsBefore = mock.receipts.size;
    await expect(
      provider.createRefund({
        paymentId: payment.id,
        amountKop: prepayRequest.amountKop,
        idempotenceKey: 'refund-no-measure',
        receipt: { customer: {}, lines: [forgotten()] },
      }),
    ).rejects.toMatchObject({ details: { status: 400, code: 'invalid_request' } });
    await expect(
      provider.createOffsetReceipt({
        paymentId: payment.id,
        idempotenceKey: 'offset-no-measure',
        customer: {},
        lines: [forgotten({ paymentMode: 'full_payment' })],
        prepaymentKop: prepayRequest.amountKop,
      }),
    ).rejects.toMatchObject({ details: { status: 400, code: 'invalid_request' } });
    expect(mock.refunds.size).toBe(0);
    expect(mock.receipts.size).toBe(receiptsBefore);
  });

  it('the error names the measure; an empty measure or the FFD code instead of the name too', async () => {
    const auth = `Basic ${Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64')}`;
    const item = {
      description: 'Деталь',
      quantity: 1,
      amount: { value: '100.00', currency: 'RUB' },
      vat_code: 1,
      payment_subject: 'commodity',
      payment_mode: 'full_prepayment',
    };
    const post = (key: string, measure: Record<string, unknown>) =>
      fetch(`${API}/payments`, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Idempotence-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: { value: '100.00', currency: 'RUB' },
          capture: true,
          confirmation: { type: 'redirect', return_url: 'https://example.test' },
          receipt: { customer: { phone: '79990000000' }, items: [{ ...item, ...measure }] },
        }),
      });
    const refused: [string, Record<string, unknown>][] = [
      ['no-measure', {}],
      ['empty-measure', { measure: '' }],
      ['ffd-code', { measure: 0 }],
    ];
    for (const [key, measure] of refused) {
      const res = await post(key, measure);
      expect(res.status, key).toBe(400);
      expect(await res.json(), key).toMatchObject({
        code: 'invalid_request',
        parameter: 'receipt',
        description: expect.stringContaining('measure'),
      });
    }
    expect((await post('piece', { measure: 'piece' })).status).toBe(200);
    expect(mock.payments.size).toBe(1);
  });
});
