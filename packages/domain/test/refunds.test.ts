/**
 * Refund planning invariants (PLAN section 2): refunds of a payment never exceed it; a repeated
 * partial refund takes only the rest; a whole-order refund after a partial one returns
 * payment - already refunded; refund receipts mirror the settlement method.
 */
import { describe, expect, it } from 'vitest';
import {
  assertRefundWithinPayment,
  buildRefundReceipt,
  planItemRefund,
  planOrderRefund,
  planOrphanRefund,
  refundableKop,
  RefundPlanError,
  refundReasonFor,
  receiptFor,
  resolveTransition,
  ReceiptLinesError,
  type ReceiptItemInput,
  type RefundRecord,
} from '../src';

const CODES = { phone: '+79123456789', vatCode: 1, taxSystemCode: 2 } as const;

const a: ReceiptItemInput = {
  orderItemId: 'item-a',
  brand: 'MANN',
  article: 'W 914/2',
  name: 'Фильтр масляный',
  qty: 2,
  priceClientKop: 64_000,
  refundedAmountKop: 0,
  state: 'ordered',
};
const b: ReceiptItemInput = {
  orderItemId: 'item-b',
  brand: 'BOSCH',
  article: '0 986',
  name: 'Колодки',
  qty: 1,
  priceClientKop: 315_000,
  refundedAmountKop: 0,
  state: 'ordered',
};
const PAYMENT = 443_000;

describe('refundableKop and assertRefundWithinPayment', () => {
  it('pending and succeeded refunds count, failed ones do not', () => {
    const refunds: RefundRecord[] = [
      { amountKop: 100_000, status: 'succeeded' },
      { amountKop: 50_000, status: 'pending' },
      { amountKop: 200_000, status: 'failed' },
    ];
    expect(refundableKop(PAYMENT, refunds)).toBe(293_000);
    expect(() => assertRefundWithinPayment(PAYMENT, refunds, 293_000)).not.toThrow();
    expect(() => assertRefundWithinPayment(PAYMENT, refunds, 293_001)).toThrow(RefundPlanError);
    expect(() => assertRefundWithinPayment(PAYMENT, [], 0)).toThrow(RefundPlanError);
    expect(refundableKop(100, [{ amountKop: 200, status: 'succeeded' }])).toBe(0);
  });
});

describe('planItemRefund', () => {
  it('refunds the whole line of an item', () => {
    expect(planItemRefund({ item: b, paymentKop: PAYMENT })).toEqual({
      amountKop: 315_000,
      lines: [
        {
          orderItemId: 'item-b',
          subject: 'commodity',
          description: 'BOSCH 0 986 Колодки',
          qty: 1,
          unitPriceKop: 315_000,
          amountKop: 315_000,
        },
      ],
    });
  });

  it('a repeated partial refund of the same item takes only the rest', () => {
    const half = { ...a, refundedAmountKop: 64_000, state: 'refund_pending' as const };
    expect(planItemRefund({ item: half }).lines).toEqual([
      expect.objectContaining({ qty: 1, unitPriceKop: 64_000, amountKop: 64_000 }),
    ]);
    // a remainder that is not whole units is one line of quantity 1
    const odd = { ...a, refundedAmountKop: 1_000 };
    expect(planItemRefund({ item: odd }).lines).toEqual([
      expect.objectContaining({ qty: 1, unitPriceKop: 127_000, amountKop: 127_000 }),
    ]);
  });

  it('a pending refund of the item is not refunded twice', () => {
    const refunds: RefundRecord[] = [
      {
        amountKop: 64_000,
        status: 'pending',
        items: [{ orderItemId: 'item-a', subject: 'commodity', amountKop: 64_000 }],
      },
    ];
    expect(planItemRefund({ item: a, refunds, paymentKop: PAYMENT }).amountKop).toBe(64_000);
    expect(() =>
      planItemRefund({
        item: { ...a, refundedAmountKop: 128_000 },
        refunds: [],
      }),
    ).toThrow(RefundPlanError);
    expect(() => planItemRefund({ item: { ...a, state: 'refunded' } })).toThrow(RefundPlanError);
  });

  it('never exceeds the refundable rest of the payment', () => {
    expect(() =>
      planItemRefund({
        item: b,
        paymentKop: PAYMENT,
        refunds: [{ amountKop: 200_000, status: 'succeeded' }],
      }),
    ).toThrow(RefundPlanError);
  });
});

describe('planOrderRefund', () => {
  it('whole order: every live item plus delivery = the payment', () => {
    const plan = planOrderRefund({
      items: [a, b],
      courierFeeKop: 30_000,
      paymentKop: PAYMENT + 30_000,
      refunds: [],
    });
    expect(plan.amountKop).toBe(PAYMENT + 30_000);
    expect(plan.lines.map((l) => [l.orderItemId, l.subject, l.amountKop])).toEqual([
      ['item-a', 'commodity', 128_000],
      ['item-b', 'commodity', 315_000],
      [null, 'service', 30_000],
    ]);
  });

  it('after a succeeded partial refund: payment - already refunded', () => {
    const refunds: RefundRecord[] = [
      {
        amountKop: 315_000,
        status: 'succeeded',
        items: [{ orderItemId: 'item-b', subject: 'commodity', amountKop: 315_000 }],
      },
    ];
    const plan = planOrderRefund({
      items: [a, { ...b, state: 'refunded', refundedAmountKop: 315_000 }],
      courierFeeKop: 0,
      paymentKop: PAYMENT,
      refunds,
    });
    expect(plan.amountKop).toBe(PAYMENT - 315_000);
    expect(plan.lines).toHaveLength(1);
  });

  it('a failed item refund is retried by the order refund (refund_pending item)', () => {
    const refunds: RefundRecord[] = [
      {
        amountKop: 315_000,
        status: 'failed',
        items: [{ orderItemId: 'item-b', subject: 'commodity', amountKop: 315_000 }],
      },
    ];
    const plan = planOrderRefund({
      items: [a, { ...b, state: 'refund_pending' }],
      courierFeeKop: 0,
      paymentKop: PAYMENT,
      refunds,
    });
    expect(plan.amountKop).toBe(PAYMENT);
  });

  it('delivery is refunded once', () => {
    const refunds: RefundRecord[] = [
      {
        amountKop: 30_000,
        status: 'succeeded',
        items: [{ orderItemId: null, subject: 'service', amountKop: 30_000 }],
      },
    ];
    const plan = planOrderRefund({
      items: [a],
      courierFeeKop: 30_000,
      paymentKop: 158_000,
      refunds,
    });
    expect(plan.lines.some((l) => l.subject === 'service')).toBe(false);
    expect(plan.amountKop).toBe(128_000);
  });

  it('a plan above the payment fails and nothing is planned', () => {
    expect(() =>
      planOrderRefund({ items: [a, b], courierFeeKop: 0, paymentKop: 400_000, refunds: [] }),
    ).toThrow(RefundPlanError);
    expect(() =>
      planOrderRefund({
        items: [{ ...a, state: 'failed' }],
        courierFeeKop: 0,
        paymentKop: PAYMENT,
        refunds: [],
      }),
    ).toThrow(/nothing left/);
  });
});

describe('refund receipts mirror the receipt that took the money', () => {
  const ctx = { actor: 'client', scheme: 'prepay', fulfillment: 'pickup' } as const;

  it('refund_prepayment before the offset receipt', () => {
    const result = resolveTransition('ready', 'client_refused', ctx);
    const kind = result.ok ? receiptFor(result.rule, ctx) : null;
    expect(kind).toBe('refund_prepayment');
    const plan = planOrderRefund({
      items: [a, b],
      courierFeeKop: 0,
      paymentKop: PAYMENT,
      refunds: [],
    });
    const receipt = buildRefundReceipt({ ...CODES, kind: 'refund_prepayment', lines: plan.lines });
    expect(receipt.data.lines.every((l) => l.paymentMode === 'full_prepayment')).toBe(true);
  });

  it('refund_full after the offset receipt', () => {
    const after = { ...ctx, settlementReceiptSucceeded: true };
    const result = resolveTransition('ready', 'client_refused', after);
    expect(result.ok && receiptFor(result.rule, after)).toBe('refund_full');
    const plan = planOrderRefund({
      items: [a, b],
      courierFeeKop: 0,
      paymentKop: PAYMENT,
      refunds: [],
    });
    const receipt = buildRefundReceipt({ ...CODES, kind: 'refund_full', lines: plan.lines });
    expect(receipt.data.lines.every((l) => l.paymentMode === 'full_payment')).toBe(true);
  });
});

describe('planOrphanRefund', () => {
  it('returns the whole payment with the lines of its own receipt', () => {
    const plan = planOrphanRefund({
      paymentKop: 128_000,
      paymentKind: 'prepayment',
      originalLines: [
        {
          description: 'MANN W 914/2 Фильтр масляный',
          quantity: 2,
          unitPriceKop: 64_000,
          vatCode: 1,
          paymentSubject: 'commodity',
          paymentMode: 'full_prepayment',
        },
      ],
      items: [],
    });
    expect(plan).toMatchObject({ amountKop: 128_000, receiptKind: 'refund_prepayment' });
    expect(plan.lines).toEqual([expect.objectContaining({ qty: 2, unitPriceKop: 64_000 })]);
  });

  it('falls back to the items (refunded ones included) and checks the sum', () => {
    const items = [
      { ...a, state: 'refunded' as const, refundedAmountKop: 128_000 },
      { ...b, state: 'failed' as const },
    ];
    const plan = planOrphanRefund({ paymentKop: 128_000, paymentKind: 'full', items });
    expect(plan.receiptKind).toBe('refund_full');
    expect(plan.amountKop).toBe(128_000);
    expect(() => planOrphanRefund({ paymentKop: 1, paymentKind: 'full', items })).toThrow(
      ReceiptLinesError,
    );
  });
});

describe('refundReasonFor', () => {
  it.each([
    ['client_refused', 'refusal'],
    ['storage_expired', 'no_show'],
    ['item_cancelled', 'supplier_fail'],
    ['order_cancelled', 'supplier_fail'],
    ['approval_timeout', 'supplier_fail'],
    ['client_refund_requested', 'supplier_fail'],
    ['payment_succeeded', 'late_payment'],
    ['orphan_payment', 'late_payment'],
    ['handed_over', 'other'],
  ] as const)('%s -> %s', (event, reason) => {
    expect(refundReasonFor(event)).toBe(reason);
  });

  it('amount mismatch and claim kinds', () => {
    expect(refundReasonFor('payment_succeeded', { amountMismatch: true })).toBe('amount_mismatch');
    expect(refundReasonFor('claim_refund_approved', { claimKind: 'defect' })).toBe('defect');
    expect(refundReasonFor('claim_refund_approved')).toBe('other');
  });
});
