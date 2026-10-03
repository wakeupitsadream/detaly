// Pure unit tests: buildTransitionContext, planItemChanges and availableStaffActions on
// hand-made snapshots (no database).
import { describe, expect, it } from 'vitest';
import {
  availableStaffActions,
  availableStaffActions1C,
  buildTransitionContext,
  planItemChanges,
  resolveOrderSettings,
  type BookingSummary,
  type ClaimSummary,
  type ItemChange,
  type OrderItemRow,
  type OrderSettings,
  type OrderSnapshot,
  type PaymentRow,
  type ReceiptRow,
  type RefundRow,
} from '../src';
import { testEnv } from '@detaly/db/testing';
import type { OrderItemState, OrderStatus, PaymentScheme } from '@detaly/domain';
import { offer } from './helpers';

const NOW = new Date('2026-10-05T07:00:00.000Z');
const settings: OrderSettings = resolveOrderSettings(new Map(), testEnv());
const seller = { type: 'staff' as const, id: null, staffRole: 'seller' as const };

let seq = 0;
const uid = () => `0190d1b0-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

function item(state: OrderItemState, overrides: Partial<OrderItemRow> = {}): OrderItemRow {
  return {
    id: uid(),
    orderId: 'o',
    offerKey: 'W9142:MANN:ORB1',
    searchArticleNorm: 'W9142',
    brand: 'MANN',
    article: 'W 914/2',
    name: 'Фильтр',
    qty: 1,
    stockId: 'ORB1',
    isLocal: true,
    priceSupplierAtOrderKop: 8_000,
    priceClientKop: 10_000,
    markupBp: 2800,
    etaDate: '2026-10-08',
    offerSnapshot: offer(),
    state,
    replacedByItemId: null,
    supplierItemError: null,
    markingCode: null,
    refundedAmountKop: 0,
    arrivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: uid(),
    orderId: 'o',
    provider: 'yookassa',
    providerPaymentId: 'p',
    kind: 'prepayment',
    status: 'succeeded',
    amountKop: 20_000,
    method: null,
    idempotenceKey: uid(),
    confirmationUrl: null,
    confirmationType: 'redirect',
    confirmationData: null,
    expiresAt: null,
    request: null,
    paidAt: NOW,
    canceledAt: null,
    cancellationReason: null,
    raw: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function receipt(overrides: Partial<ReceiptRow>): ReceiptRow {
  return {
    id: uid(),
    orderId: 'o',
    paymentId: null,
    refundId: null,
    kind: 'offset',
    providerReceiptId: null,
    idempotenceKey: uid(),
    status: 'pending',
    fiscalDocumentNumber: null,
    request: null,
    response: null,
    attempts: 0,
    firstAttemptAt: null,
    alertedAt: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function refund(overrides: Partial<RefundRow>): RefundRow {
  return {
    id: uid(),
    orderId: 'o',
    paymentId: 'p',
    providerRefundId: null,
    amountKop: 10_000,
    items: [],
    reason: 'supplier_fail',
    status: 'pending',
    scope: 'item',
    idempotenceKey: uid(),
    request: null,
    error: null,
    retryOfRefundId: null,
    alertedAt: null,
    requestedAt: NOW,
    deadlineAt: NOW,
    succeededAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function snapshot(
  status: OrderStatus,
  options: {
    scheme?: PaymentScheme;
    items?: OrderItemRow[];
    payments?: PaymentRow[];
    receipts?: ReceiptRow[];
    refunds?: RefundRow[];
    clientArrived?: boolean;
    expiresAt?: Date | null;
    claims?: ClaimSummary[];
    bookings?: BookingSummary[];
    handedAt?: Date | null;
  } = {},
): OrderSnapshot {
  const scheme = options.scheme ?? 'prepay';
  return {
    order: {
      id: 'o',
      number: 'DT-000001',
      userId: 'u',
      accessToken: 't',
      status,
      paymentScheme: scheme,
      fulfillment: 'pickup',
      address: null,
      subtotalKop: 20_000,
      courierFeeKop: 0,
      totalKop: 20_000,
      itemsHash: 'h',
      promisedDate: null,
      pickupCode: null,
      offerVersionId: null,
      preferredChannel: null,
      checkoutKey: null,
      cartId: null,
      attentionReason: null,
      confirmedAt: null,
      paidAt: null,
      orderedAt: null,
      receivedAt: null,
      handedAt: options.handedAt ?? null,
      completedAt: null,
      cancelledAt: null,
      clientArrivedAt: options.clientArrived ? NOW : null,
      expiresAt: options.expiresAt ?? null,
      supplierReturnDeadlineAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      vinRequestId: null,
    },
    items: options.items ?? [item('ordered'), item('ordered')],
    payments: options.payments ?? (scheme === 'prepay' ? [payment()] : []),
    receipts: options.receipts ?? [],
    refunds: options.refunds ?? [],
    supplierOrders: [],
    openApproval: null,
    noShowCount: 0,
    claims: options.claims ?? [],
    bookings: options.bookings ?? [],
  };
}

describe('buildTransitionContext', () => {
  it('derives payment facts from the latest payment and the held money', () => {
    const old = payment({ status: 'canceled' });
    const last = payment({ status: 'pending', kind: 'prepayment' });
    const snap = snapshot('awaiting_payment', { payments: [old, last] });
    const ctx = buildTransitionContext(snap, seller, {}, settings, NOW);
    expect(ctx).toMatchObject({
      providerPaymentStatus: 'pending',
      eventPaymentIsCurrent: true,
      eventPaymentKind: 'prepayment',
      paymentHeld: false,
      scheme: 'prepay',
      totalKop: 20_000,
    });
    const aboutOld = buildTransitionContext(snap, seller, { paymentId: old.id }, settings, NOW);
    expect(aboutOld.eventPaymentIsCurrent).toBe(false);
  });

  it('paymentHeld: false once the payment is refunded in full or refunded as orphan', () => {
    const p = payment();
    const full = snapshot('refund_pending', {
      payments: [p],
      refunds: [
        refund({ paymentId: p.id, amountKop: 20_000, status: 'succeeded', scope: 'order' }),
      ],
    });
    expect(buildTransitionContext(full, seller, {}, settings, NOW).paymentHeld).toBe(false);
    const partial = snapshot('ordered_at_supplier', {
      payments: [p],
      refunds: [refund({ paymentId: p.id, amountKop: 10_000, status: 'succeeded' })],
    });
    expect(buildTransitionContext(partial, seller, {}, settings, NOW).paymentHeld).toBe(true);
  });

  it('counts items after the planned changes', () => {
    const a = item('ordered');
    const b = item('pending');
    const snap = snapshot('needs_attention', { items: [a, b] });
    const changes = planItemChanges('item_cancelled', snap, { itemId: b.id });
    const ctx = buildTransitionContext(snap, seller, { scope: 'item' }, settings, NOW, changes);
    expect(ctx).toMatchObject({
      pendingSupplierItems: 0,
      liveItemsAfter: 1,
      allLiveItemsArrived: false,
    });
    const before = buildTransitionContext(snap, seller, {}, settings, NOW);
    expect(before).toMatchObject({ pendingSupplierItems: 1, liveItemsAfter: 2 });
  });

  it('settlement receipt: offset for prepay, full for pay_on_handover; window elapsed', () => {
    const prepay = snapshot('ready', {
      receipts: [receipt({ kind: 'offset', status: 'succeeded' })],
      expiresAt: new Date(NOW.getTime() - 1),
    });
    expect(buildTransitionContext(prepay, seller, {}, settings, NOW)).toMatchObject({
      settlementReceiptSucceeded: true,
      pickupWindowElapsed: true,
    });
    const cod = snapshot('ready', {
      scheme: 'pay_on_handover',
      receipts: [receipt({ kind: 'offset', status: 'succeeded' })],
      expiresAt: new Date(NOW.getTime() + 1),
    });
    expect(buildTransitionContext(cod, seller, {}, settings, NOW)).toMatchObject({
      settlementReceiptSucceeded: false,
      pickupWindowElapsed: false,
      paymentHeld: false,
    });
  });

  it('facts override derived values, undefined facts do not', () => {
    const snap = snapshot('ready');
    const ctx = buildTransitionContext(
      snap,
      seller,
      { pickupWindowElapsed: true, marginBp: undefined, reason: 'price_drift' },
      settings,
      NOW,
    );
    expect(ctx.pickupWindowElapsed).toBe(true);
    expect(ctx.marginBp).toBe(2000);
    expect('reason' in ctx).toBe(false);
  });
});

describe('planItemChanges', () => {
  it('item_cancelled: refund_pending with money, failed without', () => {
    const a = item('ordered');
    const paid = snapshot('ordered_at_supplier', { items: [a, item('ordered')] });
    expect(planItemChanges('item_cancelled', paid, { itemId: a.id })).toEqual([
      { kind: 'state', itemId: a.id, to: 'refund_pending' },
    ]);
    const unpaid = snapshot('ordered_at_supplier', { scheme: 'pay_on_handover', items: [a] });
    expect(planItemChanges('item_cancelled', unpaid, { itemId: a.id })).toEqual([
      { kind: 'state', itemId: a.id, to: 'failed' },
    ]);
  });

  it('supplier_checkout_succeeded: covered -> ordered, itemErrors stay pending with the error', () => {
    const a = item('pending');
    const b = item('pending');
    const snap = snapshot('ordering', { items: [a, b] });
    const changes = planItemChanges('supplier_checkout_succeeded', snap, {
      coveredItemIds: [a.id],
      itemErrors: [{ orderItemId: b.id, error: { code: 'x' } }],
    });
    expect(changes).toEqual<ItemChange[]>([
      { kind: 'state', itemId: a.id, to: 'ordered', supplierItemError: null },
      { kind: 'state', itemId: b.id, to: 'pending', supplierItemError: { code: 'x' } },
    ]);
  });

  it('whole-order refunds move live items to refund_pending only when money is held', () => {
    const snap = snapshot('needs_attention', { items: [item('ordered'), item('failed')] });
    expect(planItemChanges('order_cancelled', snap, {}).map((c) => c.kind)).toEqual(['state']);
    const unpaid = snapshot('needs_attention', { scheme: 'pay_on_handover' });
    expect(planItemChanges('order_cancelled', unpaid, {})).toEqual([]);
  });

  it('handed_over hands live items; refund success adds the refunded amounts', () => {
    const a = item('arrived');
    const b = item('refund_pending');
    const snap = snapshot('ready', { items: [a, b] });
    expect(planItemChanges('handed_over', snap, {})).toEqual([
      { kind: 'state', itemId: a.id, to: 'handed' },
    ]);
    const r = refund({
      items: [{ orderItemId: b.id, subject: 'commodity', qty: 1, amountKop: 10_000 }],
    });
    const withRefund = { ...snap, refunds: [r] };
    expect(planItemChanges('partial_refund_succeeded', withRefund, { refundId: r.id })).toEqual([
      { kind: 'refunded', itemId: b.id, amountKop: 10_000 },
    ]);
  });

  it('events that do not touch items plan nothing', () => {
    expect(planItemChanges('client_confirmed', snapshot('awaiting_confirmation'), {})).toEqual([]);
  });
});

describe('availableStaffActions', () => {
  const codes = (snap: OrderSnapshot, role: 'seller' | 'owner' = 'seller') =>
    availableStaffActions(snap, role, settings, NOW);

  it('ready prepay before «Клиент пришёл»: «Выдал» disabled, no «Выставить оплату»', () => {
    const views = codes(snapshot('ready', { items: [item('arrived')] }));
    expect(views.map((v) => v.code)).toEqual(['came', 'handed', 'refused']);
    expect(views.find((v) => v.code === 'handed')).toMatchObject({
      enabled: false,
      disabledReason: 'Сначала «Клиент пришёл»',
    });
  });

  it('ready prepay after «Клиент пришёл»: «Ждём чек» until the offset receipt succeeds', () => {
    const pending = codes(
      snapshot('ready', {
        items: [item('arrived')],
        clientArrived: true,
        receipts: [receipt({ kind: 'offset', status: 'pending' })],
      }),
    );
    expect(pending.map((v) => v.code)).toEqual(['rcpt', 'handed', 'refused']);
    expect(pending.find((v) => v.code === 'handed')).toMatchObject({
      enabled: false,
      disabledReason: 'Ждём чек',
    });
    const done = codes(
      snapshot('ready', {
        items: [item('arrived')],
        clientArrived: true,
        receipts: [receipt({ kind: 'offset', status: 'succeeded' })],
      }),
    );
    expect(done.find((v) => v.code === 'handed')).toMatchObject({ enabled: true });
    expect(done.map((v) => v.code)).not.toContain('rcpt');
  });

  it('ready pay_on_handover: «Выставить оплату» only after «Клиент пришёл»', () => {
    const before = codes(
      snapshot('ready', { scheme: 'pay_on_handover', items: [item('arrived')] }),
    );
    expect(before.map((v) => v.code)).not.toContain('qr');
    const after = codes(
      snapshot('ready', {
        scheme: 'pay_on_handover',
        items: [item('arrived')],
        clientArrived: true,
      }),
    );
    expect(after.find((v) => v.code === 'qr')).toMatchObject({ enabled: true });
    expect(after.find((v) => v.code === 'handed')).toMatchObject({ enabled: false });
  });

  it('«Клиент не пришёл» only after the storage window', () => {
    const open = codes(
      snapshot('ready', { items: [item('arrived')], expiresAt: new Date(NOW.getTime() + 1) }),
    );
    expect(open.map((v) => v.code)).not.toContain('noshow');
    const elapsed = codes(
      snapshot('ready', { items: [item('arrived')], expiresAt: new Date(NOW.getTime() - 1) }),
    );
    expect(elapsed.map((v) => v.code)).toContain('noshow');
  });

  it('awaiting_supplier_invoice: «Счёт оплачен» for the owner only', () => {
    const snap = snapshot('awaiting_supplier_invoice');
    expect(codes(snap, 'seller').map((v) => v.code)).not.toContain('invpaid');
    expect(codes(snap, 'owner').map((v) => v.code)).toContain('invpaid');
  });

  it('ordered_at_supplier: item buttons; the last live item cannot be cancelled alone', () => {
    const a = item('ordered');
    const views = codes(snapshot('ordered_at_supplier', { items: [a] }));
    expect(views.map((v) => [v.code, v.itemId ?? null])).toEqual([
      ['iarr', a.id],
      ['iprob', a.id],
      ['refused', null],
    ]);
  });
});

describe('phase 1C: claims and bookings in the context and the staff actions', () => {
  function claim(overrides: Partial<ClaimSummary> = {}): ClaimSummary {
    return {
      id: uid(),
      orderItemId: null,
      kind: 'defect',
      openedAt: NOW,
      deadlineAt: new Date(NOW.getTime() + 10 * 86_400_000),
      decision: null,
      decidedAt: null,
      returnAcceptedAt: null,
      compensationAmountKop: null,
      refundId: null,
      closedAt: null,
      photoCount: 0,
      ...overrides,
    };
  }
  function booking(overrides: Partial<BookingSummary> = {}): BookingSummary {
    return {
      id: uid(),
      slotAt: new Date(NOW.getTime() + 3_600_000),
      status: 'requested',
      createdVia: 'web',
      confirmedAt: null,
      cancelledAt: null,
      ...overrides,
    };
  }
  const handed = (claims: ClaimSummary[], bookings: BookingSummary[] = []) =>
    snapshot('handed', {
      items: [item('handed'), item('handed')],
      claims,
      bookings,
      handedAt: NOW,
    });
  const claimViews = (snap: OrderSnapshot, role: 'seller' | 'owner' = 'seller') =>
    availableStaffActions1C(snap, role, settings, NOW)
      .filter((v) => v.claimId !== undefined)
      .map((v) => ({
        code: v.code,
        enabled: v.enabled,
        reason: v.disabledReason ?? null,
        needsReason: v.needsReason ?? false,
      }));

  it('openClaims counts the claims not closed yet (completion_timeout waits for them)', () => {
    const snap = handed([claim(), claim({ closedAt: NOW }), claim({ decision: 'replace' })]);
    expect(buildTransitionContext(snap, seller, {}, settings, NOW).openClaims).toBe(2);
    expect(buildTransitionContext(handed([]), seller, {}, settings, NOW).openClaims).toBe(0);
    // The claim facts of a decision never leak into the context.
    const ctx = buildTransitionContext(
      snap,
      seller,
      { claimId: 'c', claimOpenedAt: NOW.toISOString(), claimKind: 'defect' },
      settings,
      NOW,
    );
    expect(ctx).not.toHaveProperty('claimId');
    expect(ctx).not.toHaveProperty('claimOpenedAt');
    expect(ctx.claimKind).toBe('defect');
  });

  it('an undecided claim without the return: «Принял возврат», refund disabled for a seller', () => {
    const c = claim();
    expect(claimViews(handed([c]))).toEqual([
      { code: 'cret', enabled: true, reason: null, needsReason: false },
      { code: 'cref', enabled: false, reason: 'Сначала «Принял возврат»', needsReason: false },
      { code: 'crepl', enabled: true, reason: null, needsReason: false },
      { code: 'crej', enabled: true, reason: null, needsReason: false },
    ]);
    // The owner may refund with a reason.
    expect(claimViews(handed([c]), 'owner').find((v) => v.code === 'cref')).toEqual({
      code: 'cref',
      enabled: true,
      reason: null,
      needsReason: true,
    });
    const all = availableStaffActions1C(handed([c]), 'seller', settings, NOW);
    expect(all.filter((v) => v.claimId === c.id)).toHaveLength(4);
  });

  it('after «Принял возврат» the refund is open; replace -> only «Замена выдана»; closed -> nothing', () => {
    const accepted = claimViews(handed([claim({ returnAcceptedAt: NOW })]));
    expect(accepted.map((v) => v.code)).toEqual(['cref', 'crepl', 'crej']);
    expect(accepted[0]).toMatchObject({ enabled: true });
    expect(claimViews(handed([claim({ decision: 'replace' })])).map((v) => v.code)).toEqual([
      'cclose',
    ]);
    expect(claimViews(handed([claim({ decision: 'reject', closedAt: NOW })]))).toEqual([]);
  });

  it('a delay before the handover: refund and reject only', () => {
    const snap = snapshot('ordered_at_supplier', { claims: [claim({ kind: 'delay' })] });
    expect(claimViews(snap)).toEqual([
      { code: 'cref', enabled: true, reason: null, needsReason: false },
      { code: 'crej', enabled: true, reason: null, needsReason: false },
    ]);
  });

  it('«Фото упаковки» on the way and at the point; the 1B buttons stay as they were', () => {
    const codes1C = (status: OrderStatus) =>
      availableStaffActions1C(snapshot(status), 'seller', settings, NOW).map((v) => v.code);
    expect(codes1C('ordered_at_supplier')).toEqual(['pphoto']);
    expect(codes1C('ready')).toEqual(['pphoto']);
    expect(codes1C('confirmed')).toEqual([]);
    const oneB = availableStaffActions(handed([claim()]), 'seller', settings, NOW);
    expect(oneB.some((v) => v.claimId !== undefined)).toBe(false);
  });

  it('two open claims are told apart by kind and item', () => {
    const snap = handed([claim(), claim({ kind: 'not_fit' })]);
    const labels = availableStaffActions1C(snap, 'seller', settings, NOW)
      .filter((v) => v.code === 'crej')
      .map((v) => v.label);
    expect(labels).toEqual(['Отказать по претензии · Брак', 'Отказать по претензии · Не подошла']);
  });

  it('bookings: confirm / decline; done and no-show only after the slot started', () => {
    const requested = booking();
    const confirmed = booking({ status: 'confirmed', confirmedAt: NOW });
    const views = availableStaffActions1C(
      handed([], [requested, confirmed, booking({ status: 'cancelled' })]),
      'seller',
      settings,
      NOW,
    ).filter((v) => v.bookingId !== undefined);
    expect(views.map((v) => [v.code, v.bookingId, v.enabled])).toEqual([
      ['bconf', requested.id, true],
      ['bdecl', requested.id, true],
      ['bdone', confirmed.id, false],
      ['bnoshow', confirmed.id, false],
      ['bdecl', confirmed.id, true],
    ]);
    expect(views.find((v) => v.code === 'bdone')?.disabledReason).toBe(
      'Время записи ещё не наступило',
    );
    expect(views[0]?.label).toMatch(/^Подтвердить запись \S+ \d+ \S+ \d{2}:\d{2}$/);
    const later = availableStaffActions1C(
      handed([], [confirmed]),
      'seller',
      settings,
      new Date(NOW.getTime() + 2 * 3_600_000),
    ).filter((v) => v.bookingId !== undefined);
    expect(later.map((v) => [v.code, v.enabled])).toEqual([
      ['bdone', true],
      ['bnoshow', true],
      ['bdecl', true],
    ]);
  });
});
