/**
 * Specification of the order state machine (docs/PLAN.md section 3,
 * docs/phase0-implementation.md section 4). EXPECTED is written by hand from the PLAN table and
 * is deliberately independent from TRANSITIONS: every (status, event) pair that has a rule must
 * appear here, and every other pair of 17 statuses x all events must resolve to `no_rule`.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPES,
  effectsFor,
  liveItemsAllArrived,
  ORDER_EVENTS,
  ORDER_NOTIFY_TEMPLATES,
  ORDER_STATUSES,
  type OrderEvent,
  PARTIAL_REFUND_STATUSES,
  type OrderStatus,
  receiptFor,
  resolveTransition,
  rulesFor,
  TERMINAL_ORDER_STATUSES,
  type TransitionContext,
  type TransitionRule,
  TRANSITIONS,
} from '../src';

// ---------------------------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------------------------

const PREPAY = { scheme: 'prepay', fulfillment: 'pickup' } as const;
/** pay_on_handover before the handover QR payment: no money held. */
const COD = { scheme: 'pay_on_handover', fulfillment: 'pickup', paymentHeld: false } as const;
/** pay_on_handover after the handover QR payment succeeded (money held). */
const COD_PAID = { ...COD, paymentHeld: true } as const;
/** Back to work after a problem: every live item is ordered at Rossko, nothing blocks shipping. */
const ORDERED = { pendingSupplierItems: 0, prepayInvoice: false } as const;
/** Some live items still need GetCheckout (recheck failed, itemErrors, approved alternative). */
const NOT_ORDERED = { pendingSupplierItems: 1 } as const;
/** Everything is ordered, but Rossko ships only after its invoice is paid, and it is not yet. */
const INVOICE_DUE = { pendingSupplierItems: 0, prepayInvoice: true } as const;
/** A payment event about the order's latest payment, confirmed not paid by GET /payments. */
const CURRENT_CANCELED = {
  eventPaymentIsCurrent: true,
  providerPaymentStatus: 'canceled',
} as const;
const COURIER = { scheme: 'prepay', fulfillment: 'courier' } as const;

const client = (extra: Partial<TransitionContext> = {}): TransitionContext => ({
  actor: 'client',
  ...PREPAY,
  ...extra,
});
const staff = (extra: Partial<TransitionContext> = {}): TransitionContext => ({
  actor: 'staff',
  staffRole: 'seller',
  ...PREPAY,
  ...extra,
});
const ownerCtx = (extra: Partial<TransitionContext> = {}): TransitionContext =>
  staff({ staffRole: 'owner', ...extra });
const system = (extra: Partial<TransitionContext> = {}): TransitionContext => ({
  actor: 'system',
  ...PREPAY,
  ...extra,
});
const webhook = (extra: Partial<TransitionContext> = {}): TransitionContext => ({
  actor: 'webhook',
  ...PREPAY,
  ...extra,
});

/** Checkout of an all-local cart: 14 999 ₽, no no-shows, pickup. */
const checkout = (extra: Partial<TransitionContext> = {}): TransitionContext => ({
  actor: 'client',
  fulfillment: 'pickup',
  hasPdConsent: true,
  allItemsLocal: true,
  totalKop: 1_499_900,
  minOrderTotalKop: 0,
  orderMarginKop: 300_000,
  minMarginKop: 0,
  onPickupMaxTotalKop: 1_500_000,
  noShowCount: 0,
  noShowLimit: 2,
  ...extra,
});

const paid = (amount: number, extra: Partial<TransitionContext> = {}): TransitionContext =>
  webhook({
    totalKop: 500_000,
    paidAmountKop: amount,
    providerPaymentStatus: 'succeeded',
    allLiveItemsArrived: false,
    ...extra,
  });

const recheck = (drift: number, extra: Partial<TransitionContext> = {}): TransitionContext =>
  staff({ priceDriftBp: drift, driftToleranceBp: 300, allAvailable: true, ...extra });

type Row = readonly [OrderStatus, OrderEvent, TransitionContext, OrderStatus];

// ---------------------------------------------------------------------------------------------
// EXPECTED: [from, event, ctx, to], following the rows of the PLAN section 3 table
// ---------------------------------------------------------------------------------------------

const EXPECTED: readonly Row[] = [
  // draft: checkout splits by eligibility for payment on handover
  ['draft', 'checkout', checkout(), 'awaiting_confirmation'],
  ['draft', 'checkout', checkout({ allItemsLocal: false }), 'awaiting_payment'],
  ['draft', 'checkout', checkout({ totalKop: 1_500_100 }), 'awaiting_payment'],
  ['draft', 'checkout', checkout({ noShowCount: 2 }), 'awaiting_payment'],
  ['draft', 'checkout', checkout({ fulfillment: 'courier' }), 'awaiting_payment'],
  ['draft', 'checkout_stale', system(), 'draft'],

  // awaiting_payment
  ['awaiting_payment', 'payment_succeeded', paid(500_000), 'confirmed'],
  ['awaiting_payment', 'payment_succeeded', paid(499_900), 'needs_attention'],
  ['awaiting_payment', 'payment_succeeded', paid(500_000, { allLiveItemsArrived: true }), 'ready'],
  [
    'awaiting_payment',
    'payment_canceled',
    webhook({ ...CURRENT_CANCELED, allLiveItemsArrived: false }),
    'cancelled',
  ],
  [
    'awaiting_payment',
    'payment_canceled',
    webhook({ ...CURRENT_CANCELED, allLiveItemsArrived: true }),
    'ready',
  ],
  [
    'awaiting_payment',
    'payment_ttl_expired',
    system({ ...CURRENT_CANCELED, allLiveItemsArrived: false }),
    'cancelled',
  ],
  [
    'awaiting_payment',
    'payment_ttl_expired',
    system({
      eventPaymentIsCurrent: true,
      providerPaymentStatus: null,
      allLiveItemsArrived: false,
    }),
    'cancelled',
  ],
  [
    'awaiting_payment',
    'payment_ttl_expired',
    system({ ...CURRENT_CANCELED, allLiveItemsArrived: true }),
    'ready',
  ],

  // client cancellation before payment (phase 1A, decision Д3)
  [
    'awaiting_payment',
    'client_cancelled',
    client({ providerPaymentStatus: null, allLiveItemsArrived: false }),
    'cancelled',
  ],
  // ... and after «Оплатить заранее» on a ready order: a refusal with the supplier-return task
  [
    'awaiting_payment',
    'client_cancelled',
    client({ providerPaymentStatus: 'pending', allLiveItemsArrived: true }),
    'cancelled',
  ],

  // cancelled: late payment must be refunded
  ['cancelled', 'payment_succeeded', paid(500_000), 'refund_pending'],
  ['cancelled', 'payment_succeeded', paid(500_000, { ...COD }), 'refund_pending'],

  // awaiting_confirmation (pay_on_handover)
  ['awaiting_confirmation', 'client_confirmed', client({ ...COD }), 'confirmed'],
  ['awaiting_confirmation', 'confirmation_timeout', system({ ...COD }), 'cancelled'],
  ['awaiting_confirmation', 'client_cancelled', client({ ...COD }), 'cancelled'],

  // confirmed -> ordering after the recheck, or needs_attention
  ['confirmed', 'supplier_order_requested', recheck(300), 'ordering'],
  ['confirmed', 'supplier_order_requested', recheck(-500), 'ordering'],
  ['confirmed', 'supplier_order_requested', recheck(301), 'needs_attention'],
  ['confirmed', 'supplier_order_requested', recheck(0, { allAvailable: false }), 'needs_attention'],

  // ordering: GetCheckout outcome
  [
    'ordering',
    'supplier_checkout_succeeded',
    system({ supplierItemErrors: 0, prepayInvoice: false }),
    'ordered_at_supplier',
  ],
  [
    'ordering',
    'supplier_checkout_succeeded',
    system({ supplierItemErrors: 0, prepayInvoice: true }),
    'awaiting_supplier_invoice',
  ],
  ['ordering', 'supplier_checkout_succeeded', system({ supplierItemErrors: 1 }), 'needs_attention'],
  ['ordering', 'supplier_checkout_failed', system(), 'needs_attention'],
  ['awaiting_supplier_invoice', 'supplier_invoice_paid', ownerCtx(), 'ordered_at_supplier'],

  // ordered_at_supplier
  ['ordered_at_supplier', 'item_problem', staff(), 'needs_attention'],
  ['ordered_at_supplier', 'item_arrived', staff({ allLiveItemsArrived: true }), 'ready'],
  [
    'ordered_at_supplier',
    'item_arrived',
    staff({ allLiveItemsArrived: false }),
    'ordered_at_supplier',
  ],
  ['ordered_at_supplier', 'item_damaged_on_receipt', staff(), 'ordered_at_supplier'],
  ['ordered_at_supplier', 'eta_changed', system(), 'ordered_at_supplier'],
  // "Жду до <дата>" / "Отменить позицию": partial refund of a delayed item
  [
    'ordered_at_supplier',
    'item_cancelled',
    client({ scope: 'item', liveItemsAfter: 1, allLiveItemsArrived: false }),
    'ordered_at_supplier',
  ],
  [
    'ordered_at_supplier',
    'item_cancelled',
    staff({ ...COD, scope: 'item', liveItemsAfter: 2, allLiveItemsArrived: true }),
    'ready',
  ],

  // needs_attention
  [
    'needs_attention',
    'order_anyway',
    staff({ marginBp: 1000, marginFloorBp: 1000, ...ORDERED }),
    'ordered_at_supplier',
  ],
  [
    'needs_attention',
    'order_anyway',
    staff({ marginBp: 1000, marginFloorBp: 1000, ...NOT_ORDERED }),
    'ordering',
  ],
  [
    'needs_attention',
    'order_anyway',
    staff({ marginBp: 1000, marginFloorBp: 1000, ...INVOICE_DUE }),
    'awaiting_supplier_invoice',
  ],
  [
    'needs_attention',
    'order_anyway',
    staff({ marginBp: 1000, marginFloorBp: 1000, ...INVOICE_DUE, supplierInvoicePaid: true }),
    'ordered_at_supplier',
  ],
  [
    'needs_attention',
    'alternative_proposed',
    staff({ clientReachable: true }),
    'awaiting_client_approval',
  ],
  [
    'needs_attention',
    'new_eta_proposed',
    staff({ clientReachable: true }),
    'awaiting_client_approval',
  ],
  [
    'needs_attention',
    'item_cancelled',
    staff({ liveItemsAfter: 1, ...ORDERED }),
    'ordered_at_supplier',
  ],
  ['needs_attention', 'item_cancelled', staff({ liveItemsAfter: 1, ...NOT_ORDERED }), 'ordering'],
  [
    'needs_attention',
    'item_cancelled',
    staff({ liveItemsAfter: 1, ...INVOICE_DUE }),
    'awaiting_supplier_invoice',
  ],
  ['needs_attention', 'order_cancelled', staff(), 'refund_pending'],
  ['needs_attention', 'order_cancelled', staff({ ...COD }), 'cancelled'],
  ['needs_attention', 'order_cancelled', staff({ ...COD_PAID }), 'refund_pending'],

  // awaiting_client_approval
  ['awaiting_client_approval', 'client_approved', client({ ...ORDERED }), 'ordered_at_supplier'],
  ['awaiting_client_approval', 'client_approved', client({ ...NOT_ORDERED }), 'ordering'],
  [
    'awaiting_client_approval',
    'client_approved',
    client({ ...INVOICE_DUE }),
    'awaiting_supplier_invoice',
  ],
  [
    'awaiting_client_approval',
    'client_refund_requested',
    client({ scope: 'order' }),
    'refund_pending',
  ],
  [
    'awaiting_client_approval',
    'client_refund_requested',
    client({ scope: 'item', liveItemsAfter: 1, ...ORDERED }),
    'ordered_at_supplier',
  ],
  [
    'awaiting_client_approval',
    'client_refund_requested',
    client({ scope: 'item', liveItemsAfter: 1, ...NOT_ORDERED }),
    'ordering',
  ],
  [
    'awaiting_client_approval',
    'client_refund_requested',
    client({ scope: 'item', liveItemsAfter: 1, ...INVOICE_DUE }),
    'awaiting_supplier_invoice',
  ],
  [
    'awaiting_client_approval',
    'client_refund_requested',
    client({ ...COD, scope: 'order' }),
    'cancelled',
  ],
  ['awaiting_client_approval', 'approval_timeout', system({ scope: 'order' }), 'refund_pending'],
  [
    'awaiting_client_approval',
    'approval_timeout',
    system({ scope: 'item', liveItemsAfter: 2, ...ORDERED }),
    'ordered_at_supplier',
  ],
  [
    'awaiting_client_approval',
    'approval_timeout',
    system({ scope: 'item', liveItemsAfter: 2, ...NOT_ORDERED }),
    'ordering',
  ],
  [
    'awaiting_client_approval',
    'approval_timeout',
    system({ scope: 'item', liveItemsAfter: 2, ...INVOICE_DUE }),
    'awaiting_supplier_invoice',
  ],
  ['awaiting_client_approval', 'approval_timeout', system({ ...COD, scope: 'order' }), 'cancelled'],

  // ready: handover (prepay: offset receipt; pay_on_handover: QR payment)
  ['ready', 'client_arrived', staff(), 'ready'],
  ['ready', 'client_arrived', staff({ ...COD }), 'ready'],
  ['ready', 'offset_receipt_requested', system({ clientArrived: true }), 'ready'],
  [
    'ready',
    'handover_payment_requested',
    staff({ ...COD, clientArrived: true }),
    'awaiting_handover_payment',
  ],
  ['ready', 'handed_over', staff({ settlementReceiptSucceeded: true }), 'handed'],
  ['ready', 'switch_to_prepay', client({ ...COD }), 'awaiting_payment'],
  ['ready', 'courier_dispatched', staff({ ...COURIER }), 'out_for_delivery'],
  ['ready', 'storage_expired', system({ pickupWindowElapsed: true }), 'refund_pending'],
  ['ready', 'storage_expired', system({ ...COD, pickupWindowElapsed: true }), 'cancelled'],
  // «Клиент не пришёл» from staff after the window (decision Б10)
  ['ready', 'storage_expired', staff({ pickupWindowElapsed: true }), 'refund_pending'],
  ['ready', 'storage_expired', staff({ ...COD, pickupWindowElapsed: true }), 'cancelled'],

  // awaiting_handover_payment
  [
    'awaiting_handover_payment',
    'payment_succeeded',
    paid(500_000, { ...COD }),
    'awaiting_handover_payment',
  ],
  ['awaiting_handover_payment', 'payment_succeeded', paid(400_000, { ...COD }), 'needs_attention'],
  [
    'awaiting_handover_payment',
    'handed_over',
    staff({ ...COD, providerPaymentStatus: 'succeeded', settlementReceiptSucceeded: true }),
    'handed',
  ],
  [
    'awaiting_handover_payment',
    'payment_canceled',
    webhook({ ...COD, ...CURRENT_CANCELED }),
    'ready',
  ],
  [
    'awaiting_handover_payment',
    'payment_ttl_expired',
    system({ ...COD, ...CURRENT_CANCELED }),
    'ready',
  ],
  // decision Б9: the QR TTL does not wait for a confirmed cancel
  [
    'awaiting_handover_payment',
    'payment_ttl_expired',
    system({ ...COD, eventPaymentIsCurrent: true, providerPaymentStatus: 'pending' }),
    'ready',
  ],
  // ... and a late payment of that QR brings the order back with the money
  [
    'ready',
    'payment_succeeded',
    paid(500_000, { ...COD, eventPaymentKind: 'full' }),
    'awaiting_handover_payment',
  ],

  // a payment that succeeds while the order does not wait for one is never dropped
  ...(
    [
      'confirmed',
      'ordering',
      'awaiting_supplier_invoice',
      'ordered_at_supplier',
      'needs_attention',
      'awaiting_client_approval',
      'ready',
      'out_for_delivery',
    ] as const
  ).map((status): Row => [status, 'payment_succeeded', paid(500_000), 'needs_attention']),
  ['handed', 'payment_succeeded', paid(500_000), 'handed'],
  ['completed', 'payment_succeeded', paid(500_000), 'completed'],
  ['refund_pending', 'payment_succeeded', paid(500_000), 'refund_pending'],

  // out_for_delivery (phase 2, prepay + courier only)
  ['out_for_delivery', 'offset_receipt_requested', staff({ ...COURIER }), 'out_for_delivery'],
  [
    'out_for_delivery',
    'handed_over',
    staff({ ...COURIER, settlementReceiptSucceeded: true }),
    'handed',
  ],
  ['out_for_delivery', 'delivery_failed', staff({ ...COURIER }), 'ready'],

  // handed / completed: completion and claims
  ['handed', 'completion_timeout', system({ openClaims: 0 }), 'completed'],
  ['handed', 'claim_opened', client(), 'handed'],
  ['completed', 'claim_opened', client(), 'completed'],
  [
    'handed',
    'claim_refund_approved',
    staff({ scope: 'order', claimKind: 'not_fit', returnAccepted: true }),
    'refund_pending',
  ],
  [
    'handed',
    'claim_refund_approved',
    staff({ scope: 'item', claimKind: 'defect', returnAccepted: true }),
    'handed',
  ],
  [
    'completed',
    'claim_refund_approved',
    ownerCtx({ scope: 'order', claimKind: 'defect', ownerOverrideReason: 'фото брака' }),
    'refund_pending',
  ],
  ['completed', 'claim_refund_approved', staff({ scope: 'item', claimKind: 'delay' }), 'completed'],

  // client refusal before handover: prepay -> refund_pending, pay_on_handover -> cancelled
  ['confirmed', 'client_refused', client(), 'refund_pending'],
  ['confirmed', 'client_refused', client({ ...COD }), 'cancelled'],
  ['ordering', 'client_refused', staff(), 'refund_pending'],
  ['awaiting_supplier_invoice', 'client_refused', client(), 'refund_pending'],
  ['ordered_at_supplier', 'client_refused', client(), 'refund_pending'],
  ['ordered_at_supplier', 'client_refused', client({ ...COD }), 'cancelled'],
  ['needs_attention', 'client_refused', client(), 'refund_pending'],
  ['awaiting_client_approval', 'client_refused', client(), 'refund_pending'],
  ['ready', 'client_refused', client(), 'refund_pending'],
  ['ready', 'client_refused', client({ ...COD }), 'cancelled'],
  ['out_for_delivery', 'client_refused', client({ ...COURIER }), 'refund_pending'],
  ['awaiting_handover_payment', 'client_refused', client({ ...COD }), 'cancelled'],
  // the handover QR payment already succeeded: money is held, so it is refunded
  ['awaiting_handover_payment', 'client_refused', client({ ...COD_PAID }), 'refund_pending'],

  // refunds
  ['refund_pending', 'refund_succeeded', webhook({ refundConfirmed: true }), 'refunded'],
  ['refund_pending', 'refund_failed', webhook(), 'refund_pending'],

  // partial (one item) refunds: the status does not change (decision Б11)
  ...PARTIAL_REFUND_STATUSES.flatMap((status): Row[] => [
    [status, 'partial_refund_succeeded', webhook({ refundConfirmed: true }), status],
    [status, 'partial_refund_failed', system(), status],
  ]),
];

const pairKey = (status: OrderStatus, event: OrderEvent): string => `${status}|${event}`;
const allowedPairs = new Set(EXPECTED.map(([from, event]) => pairKey(from, event)));

// ---------------------------------------------------------------------------------------------

describe('EXPECTED rows', () => {
  it.each(EXPECTED.map((row, i) => [i, ...row] as const))(
    '#%i %s --%s--> %s',
    (_i, from, event, ctx, to) => {
      const result = resolveTransition(from, event, ctx);
      expect(result).toMatchObject({ ok: true });
      if (result.ok) expect(result.rule.to).toBe(to);
    },
  );

  it('cover every (status, event) pair that has a rule, and nothing else', () => {
    const rulePairs = new Set(
      TRANSITIONS.flatMap((rule) => rule.from.map((from) => pairKey(from, rule.event))),
    );
    expect([...rulePairs].sort()).toEqual([...allowedPairs].sort());
  });

  it('exercise every rule at least once', () => {
    const used = new Set<TransitionRule>();
    for (const [from, event, ctx] of EXPECTED) {
      const result = resolveTransition(from, event, ctx);
      if (result.ok) used.add(result.rule);
    }
    const unused = TRANSITIONS.filter((rule) => !used.has(rule)).map((rule) => rule.label);
    expect(unused).toEqual([]);
  });
});

describe('forbidden pairs', () => {
  it('every other status x event pair resolves to no_rule', () => {
    const probes = ACTOR_TYPES.map((actor) => ({ ...PREPAY, actor }));
    let checked = 0;
    for (const status of ORDER_STATUSES) {
      for (const event of ORDER_EVENTS) {
        if (allowedPairs.has(pairKey(status, event))) continue;
        for (const ctx of probes) {
          expect(resolveTransition(status, event, ctx), `${status} + ${event}`).toEqual({
            ok: false,
            reason: 'no_rule',
            failed: [],
          });
        }
        checked += 1;
      }
    }
    expect(checked).toBe(ORDER_STATUSES.length * ORDER_EVENTS.length - allowedPairs.size);
    expect(checked).toBeGreaterThan(500);
  });

  it('unknown events resolve to no_rule', () => {
    expect(resolveTransition('ready', 'teleport', staff())).toMatchObject({ reason: 'no_rule' });
  });
});

describe('guards', () => {
  describe('checkout: payment on handover eligibility', () => {
    it.each<[string, Partial<TransitionContext>, OrderStatus]>([
      ['all local, 1 499 900 kop, 1 no-show', { noShowCount: 1 }, 'awaiting_confirmation'],
      ['exactly ON_PICKUP_MAX_TOTAL', { totalKop: 1_500_000 }, 'awaiting_confirmation'],
      ['1 500 100 kop', { totalKop: 1_500_100 }, 'awaiting_payment'],
      ['two no-shows', { noShowCount: 2 }, 'awaiting_payment'],
      ['mixed cart', { allItemsLocal: false }, 'awaiting_payment'],
      ['courier', { fulfillment: 'courier' }, 'awaiting_payment'],
      [
        'unknown no-show limit falls back to prepay',
        { noShowLimit: undefined },
        'awaiting_payment',
      ],
    ])('%s -> %s', (_name, extra, to) => {
      const result = resolveTransition('draft', 'checkout', checkout(extra));
      expect(result.ok && result.rule.to).toBe(to);
    });

    it('no order without a pd consent', () => {
      expect(
        resolveTransition('draft', 'checkout', checkout({ hasPdConsent: false })),
      ).toMatchObject({
        ok: false,
        reason: 'guard_failed',
        failed: expect.arrayContaining(['pd_consent']) as unknown,
      });
    });

    it('below MIN_MARGIN_RUB the checkout is refused, at the threshold it passes', () => {
      expect(
        resolveTransition(
          'draft',
          'checkout',
          checkout({ orderMarginKop: 29_999, minMarginKop: 30_000 }),
        ),
      ).toEqual({ ok: false, reason: 'guard_failed', failed: ['min_order_margin'] });
      const exact = resolveTransition(
        'draft',
        'checkout',
        checkout({ orderMarginKop: 30_000, minMarginKop: 30_000 }),
      );
      expect(exact.ok && exact.rule.to).toBe('awaiting_confirmation');
      const prepaid = resolveTransition(
        'draft',
        'checkout',
        checkout({ allItemsLocal: false, orderMarginKop: 29_999, minMarginKop: 30_000 }),
      );
      expect(prepaid).toMatchObject({ ok: false, failed: ['min_order_margin'] });
      // the margin must be passed
      expect(
        resolveTransition('draft', 'checkout', checkout({ orderMarginKop: undefined })),
      ).toMatchObject({ ok: false, failed: ['min_order_margin'] });
    });

    it('below MIN_ORDER_TOTAL the checkout is refused', () => {
      expect(
        resolveTransition(
          'draft',
          'checkout',
          checkout({ totalKop: 50_000, minOrderTotalKop: 100_000 }),
        ),
      ).toMatchObject({ ok: false, reason: 'guard_failed' });
    });

    it('only the client checks out', () => {
      expect(resolveTransition('draft', 'checkout', checkout({ actor: 'staff' }))).toMatchObject({
        ok: false,
        reason: 'guard_failed',
        failed: expect.arrayContaining(['actor']) as unknown,
      });
    });
  });

  it('paid amount different from total -> needs_attention', () => {
    const result = resolveTransition('awaiting_payment', 'payment_succeeded', paid(500_001));
    expect(result.ok && result.rule.to).toBe('needs_attention');
    expect(result.ok && result.rule.notify).toEqual([
      { audience: 'owner', template: 'staff_amount_mismatch' },
    ]);
  });

  it('payment without amount data is not applied', () => {
    expect(
      resolveTransition('awaiting_payment', 'payment_succeeded', webhook({ totalKop: 500_000 })),
    ).toMatchObject({ ok: false, reason: 'guard_failed' });
  });

  it('TTL cancels only after the provider confirmed the payment is not paid', () => {
    for (const status of ['pending', 'waiting_for_capture', 'succeeded', undefined] as const) {
      expect(
        resolveTransition(
          'awaiting_payment',
          'payment_ttl_expired',
          system({ providerPaymentStatus: status }),
        ),
      ).toMatchObject({ ok: false, reason: 'guard_failed' });
    }
  });

  it('"order anyway" with 9.9% margin against a 10% floor is rejected', () => {
    expect(
      resolveTransition(
        'needs_attention',
        'order_anyway',
        staff({ marginBp: 990, marginFloorBp: 1000, ...ORDERED }),
      ),
    ).toEqual({ ok: false, reason: 'guard_failed', failed: ['margin_floor'] });
  });

  it('back to work after a recheck problem sends GetCheckout (no supplier order yet)', () => {
    const ctx = staff({ marginBp: 1500, marginFloorBp: 1000, ...NOT_ORDERED });
    const result = resolveTransition('needs_attention', 'order_anyway', ctx);
    expect(result.ok && result.rule.to).toBe('ordering');
    expect(result.ok && effectsFor(result.rule, ctx)).toEqual(['supplier_checkout']);
    const ordered = staff({ marginBp: 1500, marginFloorBp: 1000, ...ORDERED });
    const done = resolveTransition('needs_attention', 'order_anyway', ordered);
    expect(done.ok && effectsFor(done.rule, ordered)).toEqual([]);
    // the caller must say whether a supplier order exists
    expect(
      resolveTransition(
        'needs_attention',
        'order_anyway',
        staff({ marginBp: 1500, marginFloorBp: 1000 }),
      ),
    ).toMatchObject({ ok: false, reason: 'guard_failed' });
    const item = staff({ liveItemsAfter: 1, ...NOT_ORDERED });
    const cancelled = resolveTransition('needs_attention', 'item_cancelled', item);
    expect(cancelled.ok && effectsFor(cancelled.rule, item)).toEqual([
      'create_refund',
      'supplier_checkout',
    ]);
  });

  it('an approved alternative is ordered at Rossko even when a supplier order exists', () => {
    // the alternative replaces an ordered item: one live item is not covered by any order
    const ctx = client({ pendingSupplierItems: 1, prepayInvoice: false });
    const result = resolveTransition('awaiting_client_approval', 'client_approved', ctx);
    expect(result.ok && result.rule.to).toBe('ordering');
    expect(result.ok && effectsFor(result.rule, ctx)).toEqual(['supplier_checkout']);
    // "Новый срок": nothing to reorder
    const eta = client({ ...ORDERED });
    const same = resolveTransition('awaiting_client_approval', 'client_approved', eta);
    expect(same.ok && [same.rule.to, effectsFor(same.rule, eta)]).toEqual([
      'ordered_at_supplier',
      [],
    ]);
  });

  it('"Заказать всё равно" after partial itemErrors re-sends the failed items', () => {
    const ctx = staff({ marginBp: 1500, marginFloorBp: 1000, pendingSupplierItems: 2 });
    const result = resolveTransition('needs_attention', 'order_anyway', ctx);
    expect(result.ok && [result.rule.to, effectsFor(result.rule, ctx)]).toEqual([
      'ordering',
      ['supplier_checkout'],
    ]);
    // the caller must say how many items are still pending
    expect(
      resolveTransition(
        'needs_attention',
        'order_anyway',
        staff({ marginBp: 1500, marginFloorBp: 1000, prepayInvoice: false }),
      ),
    ).toMatchObject({ ok: false, reason: 'guard_failed' });
  });

  it('the Rossko invoice step is not skipped after itemErrors with prepay_invoice', () => {
    const errors = system({ supplierItemErrors: 1, prepayInvoice: true });
    const first = resolveTransition('ordering', 'supplier_checkout_succeeded', errors);
    expect(first.ok && first.rule.to).toBe('needs_attention');
    // the failed item is cancelled, everything else is ordered, the invoice is not paid
    const ctx = staff({ liveItemsAfter: 1, ...INVOICE_DUE });
    const result = resolveTransition('needs_attention', 'item_cancelled', ctx);
    expect(result.ok && result.rule.to).toBe('awaiting_supplier_invoice');
    expect(result.ok && result.rule.notify).toContainEqual({
      audience: 'owner',
      template: 'staff_supplier_invoice_due',
    });
    // a missing supplierInvoicePaid means "not paid"; a missing prepayInvoice fails closed
    const anyway = staff({ marginBp: 1500, marginFloorBp: 1000, pendingSupplierItems: 0 });
    expect(resolveTransition('needs_attention', 'order_anyway', anyway)).toMatchObject({
      ok: false,
      reason: 'guard_failed',
    });
  });

  it('a delayed item can be cancelled from ordered_at_supplier with a partial refund', () => {
    const ctx = client({ scope: 'item', liveItemsAfter: 1, allLiveItemsArrived: false });
    const result = resolveTransition('ordered_at_supplier', 'item_cancelled', ctx);
    expect(
      result.ok && [result.rule.to, receiptFor(result.rule, ctx), effectsFor(result.rule, ctx)],
    ).toEqual([
      'ordered_at_supplier',
      'refund_prepayment',
      ['create_refund', 'cancel_at_supplier_task'],
    ]);
    const cod = staff({ ...COD, scope: 'item', liveItemsAfter: 1, allLiveItemsArrived: true });
    const ready = resolveTransition('ordered_at_supplier', 'item_cancelled', cod);
    expect(
      ready.ok && [ready.rule.to, receiptFor(ready.rule, cod), effectsFor(ready.rule, cod)],
    ).toEqual(['ready', null, ['cancel_at_supplier_task', 'start_pickup_window']]);
    // the whole order goes through client_refused, not through the last item
    expect(
      resolveTransition(
        'ordered_at_supplier',
        'item_cancelled',
        client({ scope: 'item', liveItemsAfter: 0, allLiveItemsArrived: false }),
      ),
    ).toMatchObject({ ok: false, failed: ['live_items_remain'] });
    expect(
      resolveTransition(
        'ordered_at_supplier',
        'item_cancelled',
        client({ scope: 'order', liveItemsAfter: 1, allLiveItemsArrived: false }),
      ),
    ).toMatchObject({ ok: false, failed: ['scope_item'] });
  });

  it('a pay_on_handover order whose QR payment succeeded is refunded, not just cancelled', () => {
    const ctx = client({ ...COD_PAID });
    const result = resolveTransition('awaiting_handover_payment', 'client_refused', ctx);
    expect(result.ok && result.rule.to).toBe('refund_pending');
    expect(result.ok && receiptFor(result.rule, ctx)).toBe('refund_full');
    expect(result.ok && effectsFor(result.rule, ctx)).toContain('create_refund');
    // without the paymentHeld flag a pay_on_handover order is never silently cancelled
    expect(
      resolveTransition(
        'awaiting_handover_payment',
        'client_refused',
        client({ scheme: 'pay_on_handover' }),
      ),
    ).toMatchObject({ ok: false, reason: 'guard_failed' });
  });

  it('a stale cancel or expiry does not undo a succeeded handover payment', () => {
    expect(
      resolveTransition(
        'awaiting_handover_payment',
        'payment_canceled',
        webhook({ ...COD_PAID, ...CURRENT_CANCELED }),
      ),
    ).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['!payment_held'] });
    expect(
      resolveTransition(
        'awaiting_handover_payment',
        'payment_ttl_expired',
        system({ ...COD_PAID, ...CURRENT_CANCELED }),
      ),
    ).toMatchObject({ ok: false, reason: 'guard_failed' });
  });

  describe('a late cancel of an earlier payment does not touch the current one', () => {
    const stale = { eventPaymentIsCurrent: false, providerPaymentStatus: 'canceled' } as const;

    it('QR #1 canceled after "Оплатить заранее" created link #2: order stays awaiting_payment', () => {
      const ctx = webhook({ ...stale, allLiveItemsArrived: true });
      expect(resolveTransition('awaiting_payment', 'payment_canceled', ctx)).toEqual({
        ok: false,
        reason: 'guard_failed',
        failed: ['event_payment_is_current'],
      });
      expect(
        resolveTransition(
          'awaiting_payment',
          'payment_ttl_expired',
          system({ ...stale, allLiveItemsArrived: false }),
        ),
      ).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['event_payment_is_current'] });
    });

    it('QR #1 canceled after QR #2 was issued: order stays awaiting_handover_payment', () => {
      expect(
        resolveTransition(
          'awaiting_handover_payment',
          'payment_canceled',
          webhook({ ...COD, ...stale }),
        ),
      ).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['event_payment_is_current'] });
      expect(
        resolveTransition(
          'awaiting_handover_payment',
          'payment_ttl_expired',
          system({ ...COD, ...stale }),
        ),
      ).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['event_payment_is_current'] });
    });

    it('a cancel is applied only once the provider confirmed the payment is not paid', () => {
      for (const providerPaymentStatus of ['pending', 'succeeded', undefined] as const) {
        expect(
          resolveTransition(
            'awaiting_payment',
            'payment_canceled',
            webhook({
              eventPaymentIsCurrent: true,
              providerPaymentStatus,
              allLiveItemsArrived: false,
            }),
          ),
        ).toMatchObject({ ok: false, reason: 'guard_failed' });
      }
    });

    it('a payment that succeeds in ready is not lost: needs_attention and an owner alert', () => {
      const result = resolveTransition('ready', 'payment_succeeded', paid(500_000, { ...COD }));
      expect(result.ok && result.rule.to).toBe('needs_attention');
      expect(result.ok && result.rule.notify).toEqual([
        { audience: 'owner', template: 'staff_unexpected_payment' },
      ]);
      // only a payment confirmed by GET /payments counts
      expect(
        resolveTransition(
          'ready',
          'payment_succeeded',
          webhook({ providerPaymentStatus: 'pending' }),
        ),
      ).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['payment_succeeded'] });
    });
  });

  describe('missing flags never pick the negative branch (fail closed)', () => {
    it('payment of an order without allLiveItemsArrived is not applied', () => {
      expect(
        resolveTransition(
          'awaiting_payment',
          'payment_succeeded',
          paid(500_000, { allLiveItemsArrived: undefined }),
        ),
      ).toMatchObject({ ok: false, reason: 'guard_failed' });
      expect(
        resolveTransition('awaiting_payment', 'payment_canceled', webhook({ ...CURRENT_CANCELED })),
      ).toMatchObject({ ok: false, reason: 'guard_failed' });
    });

    it('item cancellation of a pay_on_handover order needs an explicit paymentHeld', () => {
      const cod = { scheme: 'pay_on_handover', scope: 'item', liveItemsAfter: 1 } as const;
      expect(
        resolveTransition('needs_attention', 'item_cancelled', staff({ ...cod, ...ORDERED })),
      ).toMatchObject({ ok: false, failed: ['payment_held_known'] });
      expect(
        resolveTransition(
          'awaiting_client_approval',
          'client_refund_requested',
          client({ ...cod, ...ORDERED }),
        ),
      ).toMatchObject({ ok: false, failed: ['payment_held_known'] });
      expect(
        resolveTransition(
          'ordered_at_supplier',
          'item_cancelled',
          client({ ...cod, allLiveItemsArrived: false }),
        ),
      ).toMatchObject({ ok: false, failed: ['payment_held_known'] });
    });

    it('GetCheckout success without the prepay_invoice setting is not applied', () => {
      expect(
        resolveTransition(
          'ordering',
          'supplier_checkout_succeeded',
          system({ supplierItemErrors: 0 }),
        ),
      ).toMatchObject({ ok: false, reason: 'guard_failed' });
    });
  });

  it('ready + prepay: payment at the point is forbidden', () => {
    expect(
      resolveTransition('ready', 'handover_payment_requested', staff({ clientArrived: true })),
    ).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['pay_on_handover'] });
  });

  it('ready + pay_on_handover: offset receipt is forbidden', () => {
    expect(
      resolveTransition(
        'ready',
        'offset_receipt_requested',
        staff({ ...COD, clientArrived: true }),
      ),
    ).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['prepay'] });
  });

  it('"Выставить оплату" is unavailable before "Клиент пришёл"', () => {
    expect(
      resolveTransition('ready', 'handover_payment_requested', staff({ ...COD })),
    ).toMatchObject({
      ok: false,
      failed: ['client_arrived'],
    });
  });

  it('"Выдал" is blocked until the settlement receipt succeeded', () => {
    expect(resolveTransition('ready', 'handed_over', staff())).toMatchObject({
      ok: false,
      failed: ['settlement_receipt_succeeded'],
    });
    expect(
      resolveTransition(
        'awaiting_handover_payment',
        'handed_over',
        staff({ ...COD, settlementReceiptSucceeded: true }),
      ),
    ).toMatchObject({ ok: false, failed: ['payment_succeeded'] });
    expect(
      resolveTransition(
        'ready',
        'handed_over',
        staff({ ...COD, settlementReceiptSucceeded: true }),
      ),
    ).toMatchObject({
      ok: false,
      failed: ['prepay'],
    });
  });

  describe('client cancellation before payment or confirmation (client_cancelled)', () => {
    it.each([null, 'pending', 'canceled'] as const)(
      'awaiting_payment with the latest payment %s -> cancelled, nobody notified',
      (status) => {
        const result = resolveTransition(
          'awaiting_payment',
          'client_cancelled',
          client({ providerPaymentStatus: status, allLiveItemsArrived: false }),
        );
        expect(result).toMatchObject({ ok: true, rule: { to: 'cancelled', notify: [] } });
        if (result.ok) expect(effectsFor(result.rule, client())).toEqual([]);
      },
    );

    it('a succeeded (or captured) payment cannot be cancelled by the client', () => {
      for (const status of ['succeeded', 'waiting_for_capture'] as const) {
        for (const allLiveItemsArrived of [false, true]) {
          expect(
            resolveTransition(
              'awaiting_payment',
              'client_cancelled',
              client({ providerPaymentStatus: status, allLiveItemsArrived }),
            ),
          ).toEqual({ ok: false, reason: 'guard_failed', failed: ['no_payment_succeeded'] });
        }
      }
    });

    it('without providerPaymentStatus or the arrival flag the guards fail closed', () => {
      expect(
        resolveTransition(
          'awaiting_payment',
          'client_cancelled',
          client({ allLiveItemsArrived: false }),
        ),
      ).toEqual({ ok: false, reason: 'guard_failed', failed: ['no_payment_succeeded'] });
      expect(
        resolveTransition(
          'awaiting_payment',
          'client_cancelled',
          client({ providerPaymentStatus: null }),
        ),
      ).toMatchObject({ ok: false, reason: 'guard_failed' });
    });

    it('liveItemsAllArrived: dropped items do not count, nothing live is not arrived', () => {
      expect(liveItemsAllArrived(['arrived', 'arrived'])).toBe(true);
      expect(liveItemsAllArrived(['arrived', 'failed', 'replaced'])).toBe(true);
      expect(liveItemsAllArrived(['arrived', 'ordered'])).toBe(false);
      expect(liveItemsAllArrived(['pending'])).toBe(false);
      expect(liveItemsAllArrived(['failed', 'refunded'])).toBe(false);
      expect(liveItemsAllArrived([])).toBe(false);
    });

    it('ready -> «Оплатить заранее» -> client_cancelled is a refusal, never a silent cancel', () => {
      const switched = resolveTransition('ready', 'switch_to_prepay', client({ ...COD }));
      expect(switched).toMatchObject({ ok: true, rule: { to: 'awaiting_payment' } });
      const ctx = client({ providerPaymentStatus: 'pending', allLiveItemsArrived: true });
      const result = resolveTransition('awaiting_payment', 'client_cancelled', ctx);
      expect(result).toMatchObject({ ok: true, rule: { to: 'cancelled' } });
      if (!result.ok) return;
      expect(result.rule.notify).toEqual([
        { audience: 'client', template: 'order_cancelled' },
        { audience: 'sellers', template: 'staff_cancel_at_supplier_task' },
      ]);
      expect(effectsFor(result.rule, ctx)).toEqual(['cancel_at_supplier_task']);
    });

    it('awaiting_confirmation is cancelled without payment data, by the client only', () => {
      expect(
        resolveTransition('awaiting_confirmation', 'client_cancelled', client({ ...COD })),
      ).toMatchObject({ ok: true, rule: { to: 'cancelled', notify: [] } });
      expect(
        resolveTransition('awaiting_confirmation', 'client_cancelled', staff({ ...COD })),
      ).toEqual({ ok: false, reason: 'guard_failed', failed: ['actor'] });
      expect(
        resolveTransition(
          'awaiting_payment',
          'client_cancelled',
          system({ providerPaymentStatus: null, allLiveItemsArrived: false }),
        ),
      ).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['actor'] });
    });

    it('after confirmation client_cancelled has no rule (client_refused applies there)', () => {
      for (const status of ['confirmed', 'ready', 'draft', 'cancelled', 'handed'] as const) {
        expect(
          resolveTransition(status, 'client_cancelled', client({ providerPaymentStatus: null })),
        ).toEqual({ ok: false, reason: 'no_rule', failed: [] });
      }
      expect(resolveTransition('confirmed', 'client_refused', client({ ...COD }))).toMatchObject({
        ok: true,
        rule: { to: 'cancelled' },
      });
    });
  });

  it('late payment of a cancelled order -> refund_pending with a refund receipt', () => {
    const result = resolveTransition('cancelled', 'payment_succeeded', paid(500_000));
    expect(result.ok && result.rule.to).toBe('refund_pending');
    expect(result.ok && receiptFor(result.rule, paid(500_000))).toBe('refund_prepayment');
    const cod = paid(500_000, { ...COD });
    const codResult = resolveTransition('cancelled', 'payment_succeeded', cod);
    expect(codResult.ok && receiptFor(codResult.rule, cod)).toBe('refund_full');
  });

  it('approval timer starts only when the client was reachable (notification not skipped)', () => {
    expect(
      resolveTransition(
        'needs_attention',
        'alternative_proposed',
        staff({ clientReachable: false }),
      ),
    ).toMatchObject({ ok: false, failed: ['client_reachable'] });
  });

  it('cancelling the last live item is not a partial cancellation', () => {
    expect(
      resolveTransition(
        'needs_attention',
        'item_cancelled',
        staff({ liveItemsAfter: 0, ...ORDERED }),
      ),
    ).toMatchObject({ ok: false, failed: ['live_items_remain'] });
  });

  it('claim refund needs an accepted return or an owner override with a reason', () => {
    const base = { scope: 'order', claimKind: 'defect' } as const;
    expect(resolveTransition('handed', 'claim_refund_approved', staff(base))).toMatchObject({
      ok: false,
      failed: expect.arrayContaining(['claim_refund_allowed']) as unknown,
    });
    expect(
      resolveTransition(
        'handed',
        'claim_refund_approved',
        staff({ ...base, ownerOverrideReason: 'x' }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      resolveTransition(
        'handed',
        'claim_refund_approved',
        ownerCtx({ ...base, ownerOverrideReason: '  ' }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      resolveTransition(
        'handed',
        'claim_refund_approved',
        ownerCtx({ ...base, ownerOverrideReason: 'брак' }),
      ),
    ).toMatchObject({ ok: true });
  });

  it('Rossko invoice is marked paid by the owner only', () => {
    expect(
      resolveTransition('awaiting_supplier_invoice', 'supplier_invoice_paid', staff()),
    ).toMatchObject({
      ok: false,
      failed: ['owner'],
    });
  });

  it('completion waits for open claims', () => {
    expect(
      resolveTransition('handed', 'completion_timeout', system({ openClaims: 1 })),
    ).toMatchObject({
      ok: false,
      failed: ['no_open_claims'],
    });
  });

  it('refund is completed only after GET /refunds confirmed it', () => {
    expect(resolveTransition('refund_pending', 'refund_succeeded', webhook())).toMatchObject({
      ok: false,
      failed: ['refund_confirmed'],
    });
  });

  describe('client refusal and storage expiry depend on the payment scheme', () => {
    it.each([
      'confirmed',
      'ordering',
      'awaiting_supplier_invoice',
      'ordered_at_supplier',
      'needs_attention',
      'awaiting_client_approval',
      'ready',
    ] as const)('%s: prepay -> refund_pending, pay_on_handover -> cancelled', (status) => {
      const pre = resolveTransition(status, 'client_refused', client());
      const cod = resolveTransition(status, 'client_refused', client({ ...COD }));
      expect(pre.ok && pre.rule.to).toBe('refund_pending');
      expect(cod.ok && cod.rule.to).toBe('cancelled');
      expect(pre.ok && receiptFor(pre.rule, client())).toBe('refund_prepayment');
      expect(cod.ok && receiptFor(cod.rule, client({ ...COD }))).toBeNull();
    });

    it('refusal after the offset receipt refunds a full settlement', () => {
      const ctx = client({ settlementReceiptSucceeded: true });
      const result = resolveTransition('ready', 'client_refused', ctx);
      expect(result.ok && receiptFor(result.rule, ctx)).toBe('refund_full');
    });

    it('refusal is not possible before confirmation or after handover', () => {
      for (const status of [
        'draft',
        'awaiting_payment',
        'awaiting_confirmation',
        'handed',
        'completed',
      ] as const) {
        expect(resolveTransition(status, 'client_refused', client())).toMatchObject({
          reason: 'no_rule',
        });
      }
    });

    it('storage expiry counts a no-show and creates the supplier return task', () => {
      const elapsed = { pickupWindowElapsed: true } as const;
      const pre = resolveTransition('ready', 'storage_expired', system(elapsed));
      const cod = resolveTransition('ready', 'storage_expired', system({ ...COD, ...elapsed }));
      expect(pre.ok && effectsFor(pre.rule, system(elapsed))).toEqual(
        expect.arrayContaining(['create_refund', 'no_show_increment', 'supplier_return_task']),
      );
      expect(cod.ok && effectsFor(cod.rule, system({ ...COD, ...elapsed }))).toEqual([
        'no_show_increment',
        'supplier_return_task',
      ]);
    });

    it('an unknown scheme is never guessed', () => {
      const unknown = client({ scheme: null });
      expect(resolveTransition('ready', 'client_refused', unknown)).toMatchObject({
        reason: 'guard_failed',
      });
      expect(resolveTransition('ready', 'storage_expired', system({ scheme: null }))).toMatchObject(
        {
          reason: 'guard_failed',
        },
      );
      expect(resolveTransition('ready', 'client_arrived', staff({ scheme: null }))).toMatchObject({
        reason: 'guard_failed',
      });
    });
  });

  it('receipts: prepayment with the payment, offset at handover, full with the QR payment', () => {
    const pay = resolveTransition('awaiting_payment', 'payment_succeeded', paid(500_000));
    expect(pay.ok && receiptFor(pay.rule, paid(500_000))).toBe('prepayment');
    const arrivedPre = resolveTransition('ready', 'client_arrived', staff());
    expect(arrivedPre.ok && receiptFor(arrivedPre.rule, staff())).toBe('offset');
    const arrivedCod = resolveTransition('ready', 'client_arrived', staff({ ...COD }));
    expect(arrivedCod.ok && receiptFor(arrivedCod.rule, staff({ ...COD }))).toBeNull();
    const qrCtx = staff({ ...COD, clientArrived: true });
    const qr = resolveTransition('ready', 'handover_payment_requested', qrCtx);
    expect(qr.ok && receiptFor(qr.rule, qrCtx)).toBe('full');
  });

  it('partial cancellation refunds money only when it was taken', () => {
    const pre = staff({ liveItemsAfter: 1, ...ORDERED });
    const cod = staff({ ...COD, liveItemsAfter: 1, ...ORDERED });
    const codPaid = staff({ ...COD_PAID, liveItemsAfter: 1, ...ORDERED });
    const c = resolveTransition('needs_attention', 'item_cancelled', codPaid);
    expect(c.ok && [receiptFor(c.rule, codPaid), effectsFor(c.rule, codPaid)]).toEqual([
      'refund_full',
      ['create_refund'],
    ]);
    const a = resolveTransition('needs_attention', 'item_cancelled', pre);
    const b = resolveTransition('needs_attention', 'item_cancelled', cod);
    expect(a.ok && [receiptFor(a.rule, pre), effectsFor(a.rule, pre)]).toEqual([
      'refund_prepayment',
      ['create_refund'],
    ]);
    expect(b.ok && [receiptFor(b.rule, cod), effectsFor(b.rule, cod)]).toEqual([null, []]);
  });
});

describe('phase 1B rules (docs/phase-1b-implementation.md section 3.4)', () => {
  it('«Клиент не пришёл» from staff before the window -> guard_failed, after -> as housekeeping', () => {
    expect(resolveTransition('ready', 'storage_expired', staff())).toEqual({
      ok: false,
      reason: 'guard_failed',
      failed: ['pickup_window_elapsed'],
    });
    expect(
      resolveTransition('ready', 'storage_expired', staff({ ...COD, pickupWindowElapsed: false })),
    ).toMatchObject({ ok: false, failed: ['pickup_window_elapsed'] });
    // housekeeping is held to the same window
    expect(resolveTransition('ready', 'storage_expired', system())).toMatchObject({
      ok: false,
      failed: ['pickup_window_elapsed'],
    });
    const bySeller = staff({ pickupWindowElapsed: true });
    const byTimer = system({ pickupWindowElapsed: true });
    const a = resolveTransition('ready', 'storage_expired', bySeller);
    const b = resolveTransition('ready', 'storage_expired', byTimer);
    expect(a.ok && b.ok && a.rule === b.rule).toBe(true);
    expect(a.ok && [receiptFor(a.rule, bySeller), effectsFor(a.rule, bySeller)]).toEqual([
      'refund_prepayment',
      ['create_refund', 'no_show_increment', 'supplier_return_task'],
    ]);
    // the client cannot mark himself a no-show
    expect(
      resolveTransition('ready', 'storage_expired', client({ pickupWindowElapsed: true })),
    ).toMatchObject({ ok: false, failed: ['actor'] });
  });

  it('QR TTL: pending at the provider -> ready, succeeded -> stays', () => {
    const current = { ...COD, eventPaymentIsCurrent: true } as const;
    for (const providerPaymentStatus of ['pending', 'canceled', null] as const) {
      const result = resolveTransition(
        'awaiting_handover_payment',
        'payment_ttl_expired',
        system({ ...current, providerPaymentStatus }),
      );
      expect(result.ok && result.rule.to, String(providerPaymentStatus)).toBe('ready');
    }
    expect(
      resolveTransition(
        'awaiting_handover_payment',
        'payment_ttl_expired',
        system({ ...current, providerPaymentStatus: 'succeeded' }),
      ),
    ).toEqual({ ok: false, reason: 'guard_failed', failed: ['no_payment_succeeded'] });
    // fails closed: a forgotten provider status or a held (two-stage) payment never drops a QR
    for (const providerPaymentStatus of [undefined, 'waiting_for_capture'] as const) {
      expect(
        resolveTransition(
          'awaiting_handover_payment',
          'payment_ttl_expired',
          system({ ...current, providerPaymentStatus }),
        ),
        String(providerPaymentStatus),
      ).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['no_payment_succeeded'] });
    }
  });

  it('an old QR paid in ready returns the order to awaiting_handover_payment silently', () => {
    const ctx = paid(500_000, { ...COD, eventPaymentKind: 'full' });
    const result = resolveTransition('ready', 'payment_succeeded', ctx);
    expect(result).toMatchObject({
      ok: true,
      rule: { to: 'awaiting_handover_payment', notify: [], label: 'Оплата по истёкшему QR прошла' },
    });
    expect(result.ok && receiptFor(result.rule, ctx)).toBeNull();
    // then «Выдал» needs the full receipt like any handover payment
    expect(
      resolveTransition(
        'awaiting_handover_payment',
        'handed_over',
        staff({ ...COD, providerPaymentStatus: 'succeeded' }),
      ),
    ).toEqual({ ok: false, reason: 'guard_failed', failed: ['settlement_receipt_succeeded'] });
  });

  it('a prepayment or a wrong amount paid in ready is an unexpected payment', () => {
    const owner = [{ audience: 'owner', template: 'staff_unexpected_payment' }];
    for (const ctx of [
      paid(500_000, { ...COD, eventPaymentKind: 'prepayment' }),
      paid(400_000, { ...COD, eventPaymentKind: 'full' }),
      paid(500_000, { eventPaymentKind: 'full' }),
      paid(500_000, { eventPaymentKind: 'prepayment' }),
    ]) {
      const result = resolveTransition('ready', 'payment_succeeded', ctx);
      expect(result).toMatchObject({ ok: true, rule: { to: 'needs_attention', notify: owner } });
    }
    // a late QR payment counts only once GET /payments confirmed it
    expect(
      resolveTransition(
        'ready',
        'payment_succeeded',
        paid(500_000, { ...COD, eventPaymentKind: 'full', providerPaymentStatus: 'pending' }),
      ),
    ).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['payment_succeeded'] });
  });

  it('"Выставить оплату" needs «Клиент пришёл»; «Выдал» needs the full receipt', () => {
    expect(
      resolveTransition('ready', 'handover_payment_requested', staff({ ...COD })),
    ).toMatchObject({ ok: false, reason: 'guard_failed', failed: ['client_arrived'] });
    expect(
      resolveTransition(
        'awaiting_handover_payment',
        'handed_over',
        staff({
          ...COD_PAID,
          providerPaymentStatus: 'succeeded',
          settlementReceiptSucceeded: false,
        }),
      ),
    ).toMatchObject({
      ok: false,
      reason: 'guard_failed',
      failed: ['settlement_receipt_succeeded'],
    });
  });

  it('partial refunds keep the status; refund_succeeded is only for refund_pending', () => {
    for (const status of PARTIAL_REFUND_STATUSES) {
      const ok = resolveTransition(
        status,
        'partial_refund_succeeded',
        webhook({ refundConfirmed: true }),
      );
      expect(ok).toMatchObject({
        ok: true,
        rule: { to: status, notify: [{ audience: 'client', template: 'money_sent' }] },
      });
      expect(resolveTransition(status, 'partial_refund_succeeded', webhook())).toMatchObject({
        ok: false,
        failed: ['refund_confirmed'],
      });
      expect(resolveTransition(status, 'partial_refund_failed', system())).toMatchObject({
        ok: true,
        rule: { to: status, notify: [{ audience: 'owner', template: 'staff_refund_failed' }] },
      });
      // staff and clients never report refund outcomes
      expect(
        resolveTransition(status, 'partial_refund_succeeded', staff({ refundConfirmed: true })),
      ).toMatchObject({ ok: false, failed: ['actor'] });
    }
    for (const status of ['draft', 'awaiting_payment', 'cancelled', 'refunded'] as const) {
      expect(
        resolveTransition(status, 'partial_refund_succeeded', webhook({ refundConfirmed: true })),
      ).toMatchObject({ reason: 'no_rule' });
    }
    expect(
      resolveTransition('ready', 'refund_succeeded', webhook({ refundConfirmed: true })),
    ).toMatchObject({ reason: 'no_rule' });
  });

  it('the new staff templates are known template ids', () => {
    for (const template of [
      'staff_orphan_payment',
      'staff_receipt_failed',
      'staff_approval_unreachable',
      'staff_refund_deadline',
    ] as const) {
      expect(ORDER_NOTIFY_TEMPLATES).toContain(template);
    }
  });
});

describe('graph properties', () => {
  const bfs = (edges: readonly (readonly [OrderStatus, OrderStatus])[]): Set<OrderStatus> => {
    const seen = new Set<OrderStatus>(['draft']);
    const queue: OrderStatus[] = ['draft'];
    while (queue.length > 0) {
      const current = queue.shift() as OrderStatus;
      for (const [from, to] of edges) {
        if (from === current && !seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    return seen;
  };

  it('every status is reachable from draft through verified EXPECTED transitions', () => {
    const reachable = bfs(EXPECTED.map(([from, , , to]) => [from, to] as const));
    expect([...reachable].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('every status is reachable from draft in the rule graph', () => {
    const reachable = bfs(TRANSITIONS.flatMap((r) => r.from.map((f) => [f, r.to] as const)));
    expect([...reachable].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('refunded has no exits', () => {
    expect(TERMINAL_ORDER_STATUSES).toEqual(['refunded']);
    expect(TRANSITIONS.filter((rule) => rule.from.includes('refunded'))).toEqual([]);
    for (const event of ORDER_EVENTS) {
      expect(
        resolveTransition('refunded', event, webhook({ refundConfirmed: true })),
      ).toMatchObject({
        reason: 'no_rule',
      });
    }
  });

  it('every non-terminal status has an exit', () => {
    for (const status of ORDER_STATUSES) {
      if ((TERMINAL_ORDER_STATUSES as readonly string[]).includes(status)) continue;
      expect(
        TRANSITIONS.some((r) => r.from.includes(status) && r.to !== status),
        status,
      ).toBe(true);
    }
  });

  it('out_for_delivery is entered only with courier and prepay', () => {
    const entries = TRANSITIONS.filter(
      (r) => r.to === 'out_for_delivery' && !r.from.includes('out_for_delivery'),
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const rule of entries) {
      for (const from of rule.from) {
        for (const scheme of ['prepay', 'pay_on_handover', null] as const) {
          for (const fulfillment of ['pickup', 'courier', null] as const) {
            for (const actor of ACTOR_TYPES) {
              const ctx: TransitionContext = { actor, scheme, fulfillment, clientArrived: true };
              const result = resolveTransition(from, rule.event, ctx);
              const entered = result.ok && result.rule.to === 'out_for_delivery';
              if (entered) {
                expect(scheme).toBe('prepay');
                expect(fulfillment).toBe('courier');
              }
            }
          }
        }
      }
    }
  });

  it('guards of rules sharing (status, event) are mutually exclusive', () => {
    const variants: Partial<TransitionContext>[] = [];
    for (const scheme of ['prepay', 'pay_on_handover', null] as const)
      for (const arrived of [true, false])
        for (const scope of ['order', 'item'] as const)
          for (const paidAmountKop of [500_000, 1])
            for (const supplierItemErrors of [0, 2])
              for (const prepayInvoice of [true, false])
                for (const priceDriftBp of [0, 1000])
                  for (const allItemsLocal of [true, false])
                    variants.push({
                      scheme,
                      fulfillment: 'pickup',
                      allLiveItemsArrived: arrived,
                      scope,
                      liveItemsAfter: 1,
                      totalKop: 500_000,
                      paidAmountKop,
                      providerPaymentStatus: 'canceled',
                      eventPaymentIsCurrent: true,
                      orderMarginKop: 100_000,
                      minMarginKop: 0,
                      supplierItemErrors,
                      prepayInvoice,
                      priceDriftBp,
                      driftToleranceBp: 300,
                      allAvailable: true,
                      allItemsLocal,
                      hasPdConsent: true,
                      onPickupMaxTotalKop: 1_500_000,
                      noShowCount: 0,
                      noShowLimit: 2,
                      claimKind: 'delay',
                      eventPaymentKind: 'full',
                      pickupWindowElapsed: true,
                    });
    // a provider-confirmed payment and a prepayment event exercise the ready payment split
    for (const variant of [...variants]) {
      variants.push({ ...variant, providerPaymentStatus: 'succeeded' });
      variants.push({
        ...variant,
        providerPaymentStatus: 'succeeded',
        eventPaymentKind: 'prepayment',
      });
    }
    // money held and supplier order flags multiply the variants for the splits that use them
    for (const variant of [...variants]) {
      variants.push({ ...variant, paymentHeld: true, pendingSupplierItems: 0 });
      variants.push({ ...variant, paymentHeld: false, pendingSupplierItems: 1 });
      variants.push({
        ...variant,
        paymentHeld: false,
        pendingSupplierItems: 0,
        supplierInvoicePaid: true,
      });
      variant.paymentHeld = true;
      variant.pendingSupplierItems = 2;
      variant.supplierInvoicePaid = false;
    }
    for (const status of ORDER_STATUSES) {
      for (const event of ORDER_EVENTS) {
        const rules = rulesFor(status, event);
        if (rules.length < 2) continue;
        for (const variant of variants) {
          for (const actor of ACTOR_TYPES) {
            const ctx: TransitionContext = { actor, staffRole: 'owner', ...variant };
            const passing = rules.filter(
              (r) => r.actors.includes(actor) && (r.guard === undefined || r.guard.test(ctx)),
            );
            expect(passing.length, `${status} + ${event}`).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('every notify template is a known template id', () => {
    for (const rule of TRANSITIONS) {
      for (const spec of rule.notify) expect(ORDER_NOTIFY_TEMPLATES).toContain(spec.template);
    }
  });

  it('every rule is described and has actors', () => {
    for (const rule of TRANSITIONS) {
      expect(rule.label.length).toBeGreaterThan(0);
      expect(rule.actors.length).toBeGreaterThan(0);
      expect(rule.from.length).toBeGreaterThan(0);
    }
  });
});

describe('side effects (implemented with the worker in phase 1B)', () => {
  it.todo('prepayment receipt (full_prepayment) is sent inside POST /payments, not separately');
  it.todo('"Выдал" stays blocked until the offset/full receipt is succeeded at the provider');
  it.todo('receipt lines are commodity only plus at most one service line (delivery)');
  it.todo('claim refund (except kind=delay) is created only after claims.return_accepted_at');
  it.todo('partial refund changes item state only, the order status stays the same');
  it.todo('refund receipt repeats the lines and payment_mode of the original receipt');
});
