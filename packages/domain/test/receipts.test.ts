/**
 * 54-FZ receipt payloads (docs/phase-1b-implementation.md section 3.3). Snapshots pin the exact
 * payload of each receipt kind; every built receipt is checked for sum of lines = amount.
 */
import { describe, expect, it } from 'vitest';
import {
  assertReceiptLines,
  buildOffsetReceipt,
  buildPaymentReceipt,
  buildRefundReceipt,
  lineDescription,
  linesTotalKop,
  paymentModeFor,
  planItemRefund,
  planOrderRefund,
  planOrphanRefund,
  RECEIPT_DESCRIPTION_MAX,
  RECEIPT_ITEM_MEASURE,
  receiptCustomerPhone,
  ReceiptLinesError,
  type ReceiptItemInput,
  type ReceiptLine,
  type RefundLine,
} from '../src';

const CODES = { phone: '+79123456789', vatCode: 1, taxSystemCode: 2 } as const;

const filter: ReceiptItemInput = {
  orderItemId: '0192a000-0000-7000-8000-000000000001',
  brand: 'MANN-FILTER',
  article: 'W 914/2',
  name: 'Фильтр масляный',
  qty: 2,
  priceClientKop: 64_000,
  refundedAmountKop: 0,
  state: 'ordered',
};
const pads: ReceiptItemInput = {
  orderItemId: '0192a000-0000-7000-8000-000000000002',
  brand: 'BOSCH',
  article: '0 986 494 524',
  name: 'Колодки тормозные передние',
  qty: 1,
  priceClientKop: 315_000,
  refundedAmountKop: 0,
  state: 'ordered',
};

describe('lineDescription and invariants (moved from @detaly/payments)', () => {
  it('builds "Бренд Артикул Название" with collapsed spaces', () => {
    expect(lineDescription(' MANN ', 'W  914/2', 'Фильтр\nмасляный')).toBe(
      'MANN W 914/2 Фильтр масляный',
    );
  });

  it('cuts a 129-character description to 128 with an ellipsis', () => {
    const name = 'я'.repeat(129 - 'B A '.length);
    const text = lineDescription('B', 'A', name);
    expect([...`B A ${name}`]).toHaveLength(129);
    expect([...text]).toHaveLength(RECEIPT_DESCRIPTION_MAX);
    expect(text.endsWith('…')).toBe(true);
    expect(lineDescription('B', 'A', name.slice(1))).toBe(`B A ${name.slice(1)}`);
  });

  it('two service lines are rejected', () => {
    const service = (unitPriceKop: number): ReceiptLine => ({
      description: 'Доставка',
      quantity: 1,
      measure: 'piece',
      unitPriceKop,
      vatCode: 1,
      paymentSubject: 'service',
      paymentMode: 'full_payment',
    });
    expect(() =>
      assertReceiptLines([service(100), service(100)], {
        totalKop: 200,
        paymentMode: 'full_payment',
      }),
    ).toThrow(/at most one service/);
  });

  it('installation cannot be a receipt line: only commodity and service exist', () => {
    const line: ReceiptLine = {
      description: 'Установка',
      quantity: 1,
      measure: 'piece',
      unitPriceKop: 100,
      vatCode: 1,
      // @ts-expect-error 'job' (a service like installation) is not a PaymentSubject
      paymentSubject: 'job',
      paymentMode: 'full_payment',
    };
    expect(() =>
      assertReceiptLines([line], { totalKop: 100, paymentMode: 'full_payment' }),
    ).toThrow(ReceiptLinesError);
  });

  it('sum of lines different from the amount -> ReceiptLinesError', () => {
    const { data } = buildPaymentReceipt({
      ...CODES,
      kind: 'prepayment',
      items: [filter],
      courierFeeKop: 0,
    });
    expect(() =>
      assertReceiptLines(data.lines, { totalKop: 127_900, paymentMode: 'full_prepayment' }),
    ).toThrow(ReceiptLinesError);
  });
});

describe('receiptCustomerPhone and paymentModeFor', () => {
  it('drops the plus of E.164', () => {
    expect(receiptCustomerPhone('+79123456789')).toBe('79123456789');
    expect(receiptCustomerPhone('79123456789')).toBe('79123456789');
    expect(() => receiptCustomerPhone('8 (912) 345-67-89')).toThrow(ReceiptLinesError);
  });

  it('refunds mirror the settlement method of the receipt that took the money', () => {
    expect(paymentModeFor('prepayment')).toBe('full_prepayment');
    expect(paymentModeFor('refund_prepayment')).toBe('full_prepayment');
    expect(paymentModeFor('full')).toBe('full_payment');
    expect(paymentModeFor('offset')).toBe('full_payment');
    expect(paymentModeFor('refund_full')).toBe('full_payment');
    expect(() => paymentModeFor('correction')).toThrow(ReceiptLinesError);
  });
});

describe('receipt payloads', () => {
  it('prepayment: two items, full_prepayment, no delivery', () => {
    const receipt = buildPaymentReceipt({
      ...CODES,
      kind: 'prepayment',
      items: [filter, pads],
      courierFeeKop: 0,
    });
    expect(receipt.amountKop).toBe(443_000);
    expect(linesTotalKop(receipt.data.lines)).toBe(receipt.amountKop);
    expect(receipt).toMatchSnapshot();
  });

  it('prepayment with a courier fee: one service line «Доставка»', () => {
    const receipt = buildPaymentReceipt({
      ...CODES,
      kind: 'prepayment',
      items: [filter],
      courierFeeKop: 30_000,
    });
    expect(receipt.amountKop).toBe(158_000);
    expect(receipt.data.lines.filter((l) => l.paymentSubject === 'service')).toEqual([
      expect.objectContaining({
        description: 'Доставка',
        quantity: 1,
        measure: 'piece',
        unitPriceKop: 30_000,
      }),
    ]);
    expect(linesTotalKop(receipt.data.lines)).toBe(receipt.amountKop);
  });

  it('full (pay_on_handover at the point): full_payment', () => {
    const receipt = buildPaymentReceipt({
      ...CODES,
      kind: 'full',
      items: [{ ...filter, state: 'arrived' }],
      courierFeeKop: 0,
    });
    expect(receipt.data.lines.every((l) => l.paymentMode === 'full_payment')).toBe(true);
    expect(linesTotalKop(receipt.data.lines)).toBe(receipt.amountKop);
    expect(receipt).toMatchSnapshot();
  });

  it('offset after a cancelled item: only the rest, prepaymentKop = payment - refund', () => {
    const paymentKop = 443_000;
    const cancelled: ReceiptItemInput = {
      ...pads,
      state: 'refunded',
      refundedAmountKop: 315_000,
    };
    const receipt = buildOffsetReceipt({
      ...CODES,
      items: [{ ...filter, state: 'arrived' }, cancelled],
      courierFeeKop: 0,
    });
    expect(receipt.prepaymentKop).toBe(paymentKop - 315_000);
    expect(receipt.data.lines).toHaveLength(1);
    expect(linesTotalKop(receipt.data.lines)).toBe(receipt.prepaymentKop);
    expect(receipt).toMatchSnapshot();
  });

  it('refund_prepayment of one line', () => {
    const plan = planItemRefund({ item: pads, refunds: [], paymentKop: 443_000 });
    const receipt = buildRefundReceipt({ ...CODES, kind: 'refund_prepayment', lines: plan.lines });
    expect(receipt.amountKop).toBe(315_000);
    expect(linesTotalKop(receipt.data.lines)).toBe(receipt.amountKop);
    expect(receipt).toMatchSnapshot();
  });

  it('refund_full of the whole order with delivery', () => {
    const items = [
      { ...filter, state: 'handed' as const },
      { ...pads, state: 'handed' as const },
    ];
    const plan = planOrderRefund({
      items,
      courierFeeKop: 30_000,
      paymentKop: 473_000,
      refunds: [],
    });
    const receipt = buildRefundReceipt({ ...CODES, kind: 'refund_full', lines: plan.lines });
    expect(receipt.amountKop).toBe(473_000);
    expect(linesTotalKop(receipt.data.lines)).toBe(receipt.amountKop);
    expect(receipt.data.lines.at(-1)).toMatchObject({
      paymentSubject: 'service',
      paymentMode: 'full_payment',
    });
    expect(receipt).toMatchSnapshot();
  });

  it('dropped items never go into a payment or offset receipt', () => {
    const items: ReceiptItemInput[] = (['failed', 'replaced', 'refund_pending'] as const).map(
      (state, i) => ({ ...pads, orderItemId: `x${i}`, state }),
    );
    const receipt = buildPaymentReceipt({
      ...CODES,
      kind: 'prepayment',
      items: [filter, ...items],
      courierFeeKop: 0,
    });
    expect(receipt.data.lines).toHaveLength(1);
    expect(() =>
      buildOffsetReceipt({ ...CODES, items: items.map((i) => ({ ...i })), courierFeeKop: 0 }),
    ).toThrow(/no lines/);
  });

  it('a refund line with a service subject other than delivery is still one service line', () => {
    const lines: RefundLine[] = [
      {
        orderItemId: null,
        subject: 'service',
        description: 'Доставка',
        qty: 1,
        unitPriceKop: 1,
        amountKop: 1,
      },
      {
        orderItemId: null,
        subject: 'service',
        description: 'Доставка',
        qty: 1,
        unitPriceKop: 1,
        amountKop: 1,
      },
    ];
    expect(() => buildRefundReceipt({ ...CODES, kind: 'refund_full', lines })).toThrow(
      /at most one service/,
    );
  });
});

describe('measure of every line (FFD 1.2 tag 2108, audit legal-3)', () => {
  it.each([
    ['without the delivery line', 0],
    ['with the delivery line', 30_000],
  ])('every receipt kind, %s: each line is in pieces', (_label, courierFeeKop) => {
    const arrived = (item: ReceiptItemInput): ReceiptItemInput => ({ ...item, state: 'arrived' });
    const items = [arrived(filter), arrived(pads)];
    const paymentKop = 443_000 + courierFeeKop;
    const order = planOrderRefund({ items, courierFeeKop, paymentKop, refunds: [] });
    const itemRefund = planItemRefund({ item: arrived(pads), refunds: [], paymentKop });
    const receipts = {
      prepayment: buildPaymentReceipt({ ...CODES, kind: 'prepayment', items, courierFeeKop }),
      full: buildPaymentReceipt({ ...CODES, kind: 'full', items, courierFeeKop }),
      offset: buildOffsetReceipt({ ...CODES, items, courierFeeKop }),
      refund_prepayment: buildRefundReceipt({
        ...CODES,
        kind: 'refund_prepayment',
        lines: order.lines,
      }),
      refund_full: buildRefundReceipt({ ...CODES, kind: 'refund_full', lines: order.lines }),
      partial_refund_by_line: buildRefundReceipt({
        ...CODES,
        kind: 'refund_prepayment',
        lines: itemRefund.lines,
      }),
    };
    expect(RECEIPT_ITEM_MEASURE).toBe('piece');
    for (const [kind, { data }] of Object.entries(receipts)) {
      const delivery = courierFeeKop > 0 && kind !== 'partial_refund_by_line' ? 1 : 0;
      expect(
        data.lines.filter((l) => l.paymentSubject === 'service'),
        kind,
      ).toHaveLength(delivery);
      expect(
        data.lines.map((l) => l.measure),
        kind,
      ).toEqual(data.lines.map(() => 'piece'));
    }
  });

  it('a refund that mirrors a receipt stored without measure still sends the piece', () => {
    // payments.request.receipt.lines of a payment created before the measure was sent.
    const stored = {
      description: 'MANN-FILTER W 914/2 Фильтр масляный',
      quantity: 2,
      unitPriceKop: 64_000,
      vatCode: 1,
      paymentSubject: 'commodity',
      paymentMode: 'full_prepayment',
    } as unknown as ReceiptLine;
    const plan = planOrphanRefund({
      paymentKop: 128_000,
      paymentKind: 'prepayment',
      originalLines: [stored],
      items: [],
    });
    const receipt = buildRefundReceipt({ ...CODES, kind: plan.receiptKind, lines: plan.lines });
    expect(receipt.data.lines).toEqual([
      expect.objectContaining({ quantity: 2, unitPriceKop: 64_000, measure: 'piece' }),
    ]);
  });
});
