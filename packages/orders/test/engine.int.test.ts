// applyTransition / persistTransition on the real database (docs/phase-1b-implementation.md
// section 5.4): each effect of table 5.2 writes exactly its rows and outbox keys, repeated events
// write nothing, parallel calls are serialized by the row lock.
import {
  and,
  clientApprovals,
  eq,
  messengerBindings,
  orderEvents,
  payments,
  receipts,
  refunds,
  supplierOrderItems,
  supplierOrders,
  supplierReturns,
  users,
  type Db,
} from '@detaly/db';
import { resolveTransition, type TransitionContext } from '@detaly/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyTransition,
  availableStaffActions,
  buildTransitionContext,
  createRefund,
  loadOrderSettings,
  loadOrderSnapshot,
  performClientAction,
  performStaffAction,
  persistTransition,
  planItemChanges,
  applyReceiptObject,
  applyRefundObject,
  type EngineDeps,
} from '../src';
import {
  assertNoPhone,
  DB_URL,
  eventsOf,
  itemRows,
  makeDeps,
  offer,
  openDb,
  orderRow,
  outboxOf,
  providerReceipt,
  providerRefund,
  seedOrder,
  setSetting,
  T0,
  testClock,
} from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const staff = { type: 'staff' as const, id: null, staffRole: 'seller' as const };
const owner = { type: 'staff' as const, id: null, staffRole: 'owner' as const };
const system = { type: 'system' as const, id: null };

describe.skipIf(!DB_URL)('applyTransition', () => {
  let db: Db;
  let deps: EngineDeps;

  beforeAll(() => {
    db = openDb();
    deps = makeDeps(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  it('persistTransition from checkout writes the notification and expires_at', async () => {
    const seeded = await seedOrder(db, { status: 'draft', payment: null });
    const settings = await loadOrderSettings(db, deps.env);
    const result = await db.transaction(async (tx) => {
      const snapshot = await loadOrderSnapshot(tx, seeded.orderId, { lock: true });
      if (!snapshot) throw new Error('no snapshot');
      const ctx: TransitionContext = {
        actor: 'client',
        hasPdConsent: true,
        allItemsLocal: false,
        totalKop: seeded.totalKop,
        minOrderTotalKop: 0,
        orderMarginKop: 42_000,
        minMarginKop: 0,
        onPickupMaxTotalKop: 1_500_000,
        noShowCount: 0,
        noShowLimit: 2,
        fulfillment: 'pickup',
      };
      const resolved = resolveTransition('draft', 'checkout', ctx);
      if (!resolved.ok) throw new Error('checkout rule');
      return persistTransition(
        tx,
        snapshot,
        { rule: resolved.rule, ctx, changes: [] },
        {
          deps,
          orderId: seeded.orderId,
          event: 'checkout',
          actor: { type: 'client', id: seeded.userId },
          payload: { part: 'all' },
        },
      );
    });
    expect(result.to).toBe('awaiting_payment');
    const order = await orderRow(db, seeded.orderId);
    expect(order.status).toBe('awaiting_payment');
    expect(order.expiresAt?.getTime()).toBe(T0.getTime() + settings.paymentTtlMin * 60_000);
    const box = await outboxOf(db, seeded.orderId);
    expect(box.map((r) => r.jobId)).toEqual([`notify:${result.orderEventId}:payment_link`]);
    expect(box[0]?.data).toMatchObject({ audience: 'client', template: 'payment_link' });
    const events = await eventsOf(db, seeded.orderId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'checkout',
      fromStatus: 'draft',
      toStatus: 'awaiting_payment',
    });
    assertNoPhone(events, seeded.phone);
  });

  it('a repeated event after success writes nothing (no_rule)', async () => {
    const seeded = await seedOrder(db, {
      scheme: 'pay_on_handover',
      status: 'awaiting_confirmation',
      payment: null,
    });
    const nudges = { count: 0 };
    const d = makeDeps(db, { nudges });
    const first = await performClientAction(d, {
      orderId: seeded.orderId,
      userId: seeded.userId,
      action: 'confirm',
    });
    expect(first).toMatchObject({ ok: true, from: 'awaiting_confirmation', to: 'confirmed' });
    expect(nudges.count).toBe(1);
    const order = await orderRow(db, seeded.orderId);
    expect(order.confirmedAt?.getTime()).toBe(T0.getTime());
    expect(order.expiresAt).toBeNull();
    const before = (await outboxOf(db, seeded.orderId)).length;
    expect(before).toBe(1);

    const second = await performClientAction(d, {
      orderId: seeded.orderId,
      userId: seeded.userId,
      action: 'confirm',
    });
    expect(second).toEqual({ ok: false, reason: 'no_rule', failed: [], status: 'confirmed' });
    expect((await outboxOf(db, seeded.orderId)).length).toBe(before);
    expect((await eventsOf(db, seeded.orderId)).length).toBe(1);
    expect(nudges.count).toBe(1);
  });

  it('parallel transitions of one order are serialized by the row lock', async () => {
    const seeded = await seedOrder(db, {
      scheme: 'pay_on_handover',
      status: 'awaiting_confirmation',
      payment: null,
    });
    const input = {
      orderId: seeded.orderId,
      event: 'client_confirmed' as const,
      actor: { type: 'client' as const, id: seeded.userId },
    };
    const results = await Promise.all([
      applyTransition(deps, input),
      applyTransition(deps, input),
      applyTransition(deps, input),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) {
      expect(r).toMatchObject({ ok: false, reason: 'no_rule', status: 'confirmed' });
    }
    expect(await eventsOf(db, seeded.orderId)).toHaveLength(1);
    expect(await outboxOf(db, seeded.orderId)).toHaveLength(1);
  });

  it('unknown order -> not_found', async () => {
    const result = await applyTransition(deps, {
      orderId: '0190d1b0-0000-7000-8000-000000000000',
      event: 'client_confirmed',
      actor: { type: 'client', id: null },
    });
    expect(result).toEqual({ ok: false, reason: 'not_found', failed: [], status: null });
  });

  it('itemErrors -> item pending, «Отменить позицию» -> partial refund, offset on the rest', async () => {
    const seeded = await seedOrder(db, { status: 'confirmed' });
    const [item1, item2] = seeded.itemIds as [string, string];

    // «Проверить и заказать» passed: supplier_checkout effect (decision Б13).
    const ordering = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'supplier_order_requested',
      actor: system,
      facts: { priceDriftBp: 100, allAvailable: true },
    });
    expect(ordering).toMatchObject({ ok: true, to: 'ordering', effects: ['supplier_checkout'] });
    const [attempt] = await db
      .select()
      .from(supplierOrders)
      .where(eq(supplierOrders.orderId, seeded.orderId));
    expect(attempt).toMatchObject({ status: 'sending', attemptNo: 1 });
    const links = await db
      .select()
      .from(supplierOrderItems)
      .where(eq(supplierOrderItems.supplierOrderId, attempt!.id));
    expect(links.map((l) => l.orderItemId).sort()).toEqual([item1, item2].sort());
    expect((await outboxOf(db, seeded.orderId)).map((r) => r.jobId)).toContain(
      `checkout:${attempt!.id}`,
    );

    // GetCheckout: item 2 in itemErrors (the worker marks the attempt created).
    await db
      .update(supplierOrders)
      .set({ status: 'created' })
      .where(eq(supplierOrders.id, attempt!.id));
    const errors = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'supplier_checkout_succeeded',
      actor: system,
      facts: {
        supplierItemErrors: 1,
        coveredItemIds: [item1],
        itemErrors: [{ orderItemId: item2, error: { code: 'out_of_stock' } }],
      },
    });
    expect(errors).toMatchObject({ ok: true, to: 'needs_attention' });
    let order = await orderRow(db, seeded.orderId);
    expect(order.attentionReason).toBe('item_errors');
    let items = await itemRows(db, seeded.orderId);
    expect(items.map((i) => i.state)).toEqual(['ordered', 'pending']);
    expect(items[1]?.supplierItemError).toEqual({ code: 'out_of_stock' });

    // pendingSupplierItems: 1 now, 0 after cancelling the item.
    const settings = await loadOrderSettings(db, deps.env);
    const snapshot = await loadOrderSnapshot(db, seeded.orderId, { lock: false });
    expect(buildTransitionContext(snapshot!, staff, {}, settings, T0).pendingSupplierItems).toBe(1);
    const cancelChanges = planItemChanges('item_cancelled', snapshot!, { itemId: item2 });
    expect(
      buildTransitionContext(snapshot!, staff, { scope: 'item' }, settings, T0, cancelChanges)
        .pendingSupplierItems,
    ).toBe(0);

    const cancel = await performStaffAction(deps, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'icancel',
      targetId: item2,
    });
    expect(cancel).toMatchObject({ ok: true });
    order = await orderRow(db, seeded.orderId);
    expect(order.status).toBe('ordered_at_supplier');
    expect(order.attentionReason).toBeNull();
    items = await itemRows(db, seeded.orderId);
    expect(items.map((i) => i.state)).toEqual(['ordered', 'refund_pending']);
    const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId));
    expect(refund).toMatchObject({ scope: 'item', amountKop: 64_000, reason: 'supplier_fail' });
    expect(refund!.deadlineAt.getTime()).toBe(T0.getTime() + 10 * DAY);
    const [refundReceipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.refundId, refund!.id));
    expect(refundReceipt?.kind).toBe('refund_prepayment');
    const receiptLines = (refundReceipt?.request as { lines: { paymentMode: string }[] }).lines;
    expect(receiptLines).toHaveLength(1);
    expect(receiptLines[0]?.paymentMode).toBe('full_prepayment');
    expect((await outboxOf(db, seeded.orderId)).map((r) => r.jobId)).toContain(
      `refund-create:${refund!.id}`,
    );

    // The partial refund succeeds: the status stays, the item is refunded.
    await db.update(refunds).set({ providerRefundId: 'rf-1' }).where(eq(refunds.id, refund!.id));
    const partial = await applyRefundObject(
      deps,
      providerRefund('rf-1', { paymentId: seeded.providerPaymentId!, amountKop: 64_000 }),
      { source: 'webhook' },
    );
    expect(partial.result).toBe('processed');
    expect(partial.transition).toMatchObject({
      ok: true,
      from: 'ordered_at_supplier',
      to: 'ordered_at_supplier',
    });
    items = await itemRows(db, seeded.orderId);
    expect(items[1]).toMatchObject({ state: 'refunded', refundedAmountKop: 64_000 });

    // Arrival -> ready with the storage window.
    const arrived = await performStaffAction(deps, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'iarr',
      targetId: item1,
    });
    expect(arrived.ok).toBe(true);
    order = await orderRow(db, seeded.orderId);
    expect(order.status).toBe('ready');
    expect(order.receivedAt?.getTime()).toBe(T0.getTime());
    expect(order.expiresAt?.getTime()).toBe(T0.getTime() + settings.pickupWindowPrepaidDays * DAY);
    expect(order.supplierReturnDeadlineAt?.getTime()).toBe(
      T0.getTime() + settings.supplierReturnDays * DAY,
    );

    // «Клиент пришёл»: the offset receipt covers payment - refund.
    const came = await performStaffAction(deps, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'came',
      targetId: seeded.orderId,
    });
    expect(came.ok).toBe(true);
    const offsets = await db
      .select()
      .from(receipts)
      .where(and(eq(receipts.orderId, seeded.orderId), eq(receipts.kind, 'offset')));
    expect(offsets).toHaveLength(1);
    const offsetRequest = offsets[0]?.request as { prepaymentKop: number; lines: unknown[] };
    expect(offsetRequest.prepaymentKop).toBe(192_000 - 64_000);
    expect(offsetRequest.lines).toHaveLength(1);
    expect((await outboxOf(db, seeded.orderId)).map((r) => r.jobId)).toContain(
      `offset:${offsets[0]!.id}`,
    );

    // «Выдал» waits for the receipt.
    let snap = await loadOrderSnapshot(db, seeded.orderId, { lock: false });
    let handed = availableStaffActions(snap!, 'seller', settings, T0).find(
      (a) => a.code === 'handed',
    );
    expect(handed).toMatchObject({ enabled: false, disabledReason: 'Ждём чек' });
    const early = await performStaffAction(deps, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'handed',
      targetId: seeded.orderId,
    });
    expect(early).toMatchObject({ ok: false, message: 'Ждём чек' });

    await applyReceiptObject(deps, offsets[0]!.id, providerReceipt('rc-1'));
    snap = await loadOrderSnapshot(db, seeded.orderId, { lock: false });
    handed = availableStaffActions(snap!, 'seller', settings, T0).find((a) => a.code === 'handed');
    expect(handed).toMatchObject({ enabled: true });
    const done = await performStaffAction(deps, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'handed',
      targetId: seeded.orderId,
    });
    expect(done.ok).toBe(true);
    order = await orderRow(db, seeded.orderId);
    expect(order.status).toBe('handed');
    expect(order.handedAt?.getTime()).toBe(T0.getTime());
    expect(order.expiresAt?.getTime()).toBe(T0.getTime() + settings.handedCompleteDays * DAY);
    items = await itemRows(db, seeded.orderId);
    expect(items.map((i) => i.state)).toEqual(['handed', 'refunded']);
    assertNoPhone(await eventsOf(db, seeded.orderId), seeded.phone);
    assertNoPhone(await outboxOf(db, seeded.orderId), seeded.phone);
  });

  it('the sum of refunds never exceeds the payment: nothing is written', async () => {
    const seeded = await seedOrder(db, { status: 'needs_attention' });
    await db.insert(refunds).values({
      orderId: seeded.orderId,
      paymentId: seeded.paymentId!,
      amountKop: 150_000,
      reason: 'other',
      scope: 'orphan',
      idempotenceKey: `k-${seeded.orderId}`,
      requestedAt: T0,
      deadlineAt: new Date(T0.getTime() + 10 * DAY),
    });
    await expect(
      db.transaction(async (tx) => {
        const snapshot = await loadOrderSnapshot(tx, seeded.orderId, { lock: true });
        return createRefund(tx, snapshot!, {
          scope: 'item',
          paymentId: seeded.paymentId!,
          reason: 'supplier_fail',
          itemIds: [seeded.itemIds[0]!],
          requestedAt: T0,
        });
      }),
    ).rejects.toThrow(/exceeds/);
    const rows = await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId));
    expect(rows).toHaveLength(1);
    expect(await outboxOf(db, seeded.orderId)).toHaveLength(0);
  });

  it('«Аналог»: unreachable client -> guard_failed; reachable -> approval; «Согласен» -> reorder', async () => {
    const seeded = await seedOrder(db, { status: 'needs_attention' });
    const [item1] = seeded.itemIds as [string, string];
    const alt = offer({
      brand: 'FILTRON',
      article: 'OP 520',
      articleNorm: 'OP520',
      priceSupplierKop: 90_000,
    });
    const proposal = {
      kind: 'alternative' as const,
      offer: alt,
      priceClientKop: 128_000,
      priceSupplierKop: 90_000,
      markupBp: 4222,
      etaDate: '2026-10-09',
      searchArticleNorm: 'OP520',
      offerKey: 'OP520:FILTRON:ORB1',
      marginBp: 2968,
    };
    const unreachable = await performStaffAction(deps, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'ialt',
      targetId: item1,
      input: { proposal },
    });
    expect(unreachable).toMatchObject({
      ok: false,
      message: 'Клиенту не доставить сообщение — позвоните ему',
    });
    expect(
      await db.select().from(clientApprovals).where(eq(clientApprovals.orderId, seeded.orderId)),
    ).toHaveLength(0);

    const smsDeps = makeDeps(db, { env: { SMS_PROVIDER: 'smsaero' } });
    const reachable = await performStaffAction(smsDeps, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'ialt',
      targetId: item1,
      input: { proposal },
    });
    expect(reachable.ok).toBe(true);
    let order = await orderRow(db, seeded.orderId);
    expect(order.status).toBe('awaiting_client_approval');
    const [approval] = await db
      .select()
      .from(clientApprovals)
      .where(eq(clientApprovals.orderId, seeded.orderId));
    expect(approval).toMatchObject({
      kind: 'alternative',
      scope: 'item',
      orderItemId: item1,
      expiresAt: null,
    });
    const box = await outboxOf(db, seeded.orderId);
    expect(box.some((r) => r.jobId.endsWith(':decision_needed'))).toBe(true);

    const approved = await performClientAction(deps, {
      orderId: seeded.orderId,
      userId: seeded.userId,
      action: 'approve',
    });
    expect(approved).toMatchObject({ ok: true, to: 'ordering' });
    const items = await itemRows(db, seeded.orderId);
    expect(items).toHaveLength(3);
    const replaced = items.find((i) => i.id === item1)!;
    expect(replaced.state).toBe('replaced');
    const fresh = items.find((i) => i.id === replaced.replacedByItemId)!;
    expect(fresh).toMatchObject({ state: 'pending', brand: 'FILTRON', priceClientKop: 128_000 });
    const [decided] = await db
      .select()
      .from(clientApprovals)
      .where(eq(clientApprovals.id, approval!.id));
    expect(decided).toMatchObject({ decision: 'approved' });
    // GetCheckout for every live pending item (the alternative and the not yet ordered one).
    const [attempt] = await db
      .select()
      .from(supplierOrders)
      .where(eq(supplierOrders.orderId, seeded.orderId));
    const links = await db
      .select()
      .from(supplierOrderItems)
      .where(eq(supplierOrderItems.supplierOrderId, attempt!.id));
    expect(links.map((l) => l.orderItemId)).toContain(fresh.id);
    order = await orderRow(db, seeded.orderId);
    expect(order.promisedDate).not.toBeNull();
  });

  it('a messenger binding makes the client reachable without SMS', async () => {
    const seeded = await seedOrder(db, { status: 'needs_attention' });
    await db.insert(messengerBindings).values({
      userId: seeded.userId,
      channel: 'telegram',
      externalUserId: `tg-${seeded.orderId}`,
      chatId: `chat-${seeded.orderId}`,
    });
    const result = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'new_eta_proposed',
      actor: staff,
      facts: { proposal: { kind: 'new_eta', etaDate: '2026-10-20', note: null } },
    });
    expect(result).toMatchObject({ ok: true, to: 'awaiting_client_approval' });
    const [approval] = await db
      .select()
      .from(clientApprovals)
      .where(eq(clientApprovals.orderId, seeded.orderId));
    expect(approval).toMatchObject({ scope: 'order', kind: 'new_eta' });

    // No answer in time: the whole order is refunded (prepay).
    const timeout = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'approval_timeout',
      actor: system,
    });
    expect(timeout).toMatchObject({ ok: true, to: 'refund_pending' });
    const [decided] = await db
      .select()
      .from(clientApprovals)
      .where(eq(clientApprovals.id, approval!.id));
    expect(decided?.decision).toBe('timeout');
    const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId));
    expect(refund).toMatchObject({ scope: 'order', amountKop: 192_000, reason: 'supplier_fail' });
    expect((await itemRows(db, seeded.orderId)).map((i) => i.state)).toEqual([
      'refund_pending',
      'refund_pending',
    ]);
  });

  it('storage_expired: only after the window; refund, no-show, supplier return task', async () => {
    const clock = testClock();
    const d = makeDeps(db, { clock });
    const seeded = await seedOrder(db, {
      status: 'ready',
      receivedAt: T0,
      expiresAt: new Date(T0.getTime() + 10 * DAY),
    });
    const early = await performStaffAction(d, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'noshow',
      targetId: seeded.orderId,
    });
    expect(early).toMatchObject({ ok: false, message: 'Срок хранения ещё не истёк' });

    clock.advance(10 * DAY + 1);
    const late = await performStaffAction(d, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'noshow',
      targetId: seeded.orderId,
    });
    expect(late.ok).toBe(true);
    const order = await orderRow(db, seeded.orderId);
    expect(order.status).toBe('refund_pending');
    expect(order.expiresAt).toBeNull();
    const [user] = await db.select().from(users).where(eq(users.id, seeded.userId));
    expect(user?.noShowCount).toBe(1);
    const returns = await db
      .select()
      .from(supplierReturns)
      .where(eq(supplierReturns.orderItemId, seeded.itemIds[0]!));
    expect(returns).toEqual([
      expect.objectContaining({ kind: 'return', status: 'requested', amountExpectedKop: 100_000 }),
    ]);
    const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId));
    expect(refund).toMatchObject({ reason: 'no_show', scope: 'order' });
    const events = await eventsOf(db, seeded.orderId);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['storage_expired', 'refund_created', 'supplier_return_created']),
    );
    const jobs = (await outboxOf(db, seeded.orderId)).map((r) => r.jobId);
    const transition = events.find((e) => e.type === 'storage_expired')!;
    expect(jobs).toEqual(
      expect.arrayContaining([
        `notify:${transition.id}:storage_expired`,
        `notify:${transition.id}:staff_supplier_return_task`,
        `refund-create:${refund!.id}`,
      ]),
    );
  });

  it('«Повреждено при приёмке»: claim to the supplier and a reorder of a copy', async () => {
    const seeded = await seedOrder(db, { status: 'ordered_at_supplier' });
    const [item1] = seeded.itemIds as [string, string];
    const result = await performStaffAction(deps, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'iprob',
      targetId: item1,
      input: { problem: 'damaged' },
    });
    expect(result.ok).toBe(true);
    expect((await orderRow(db, seeded.orderId)).status).toBe('ordered_at_supplier');
    const items = await itemRows(db, seeded.orderId);
    const old = items.find((i) => i.id === item1)!;
    expect(old.state).toBe('replaced');
    const copy = items.find((i) => i.id === old.replacedByItemId)!;
    expect(copy).toMatchObject({
      state: 'pending',
      article: old.article,
      priceClientKop: old.priceClientKop,
    });
    const [claim] = await db
      .select()
      .from(supplierReturns)
      .where(eq(supplierReturns.orderItemId, item1));
    expect(claim).toMatchObject({ kind: 'claim', status: 'requested' });
    const [attempt] = await db
      .select()
      .from(supplierOrders)
      .where(eq(supplierOrders.orderId, seeded.orderId));
    expect(attempt?.status).toBe('sending');
    const links = await db
      .select()
      .from(supplierOrderItems)
      .where(eq(supplierOrderItems.supplierOrderId, attempt!.id));
    expect(links.map((l) => l.orderItemId)).toEqual([copy.id]);

    // The reorder's GetCheckout result is applied while the order stays ordered_at_supplier.
    await db
      .update(supplierOrders)
      .set({ status: 'created' })
      .where(eq(supplierOrders.id, attempt!.id));
    const reordered = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'supplier_checkout_succeeded',
      actor: system,
      facts: { supplierItemErrors: 0, coveredItemIds: [copy.id] },
    });
    expect(reordered).toMatchObject({ ok: true, to: 'ordered_at_supplier' });
    const after = await itemRows(db, seeded.orderId);
    expect(after.find((i) => i.id === copy.id)?.state).toBe('ordered');
  });

  it('a failed reorder of a damaged item goes to needs_attention', async () => {
    const seeded = await seedOrder(db, { status: 'ordered_at_supplier' });
    const [item1] = seeded.itemIds as [string, string];
    await performStaffAction(deps, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'iprob',
      targetId: item1,
      input: { problem: 'damaged' },
    });
    const failed = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'supplier_checkout_failed',
      actor: system,
    });
    expect(failed).toMatchObject({ ok: true, to: 'needs_attention' });
    expect((await orderRow(db, seeded.orderId)).attentionReason).toBe('checkout_failed');
  });

  it('«Выставить оплату»: only after «Клиент пришёл»; QR payment rows and outbox', async () => {
    const seeded = await seedOrder(db, {
      scheme: 'pay_on_handover',
      status: 'ready',
      receivedAt: T0,
      expiresAt: new Date(T0.getTime() + 7 * DAY),
      payment: null,
    });
    const settings = await loadOrderSettings(db, deps.env);
    let snapshot = await loadOrderSnapshot(db, seeded.orderId, { lock: false });
    let codes = availableStaffActions(snapshot!, 'seller', settings, T0).map((a) => a.code);
    expect(codes).toContain('came');
    expect(codes).not.toContain('qr');
    const tooEarly = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'handover_payment_requested',
      actor: staff,
    });
    expect(tooEarly).toMatchObject({
      ok: false,
      reason: 'guard_failed',
      failed: ['client_arrived'],
    });

    expect(
      (
        await applyTransition(deps, {
          orderId: seeded.orderId,
          event: 'client_arrived',
          actor: staff,
        })
      ).ok,
    ).toBe(true);
    // pay_on_handover: «Клиент пришёл» creates no offset receipt.
    expect(
      await db.select().from(receipts).where(eq(receipts.orderId, seeded.orderId)),
    ).toHaveLength(0);
    snapshot = await loadOrderSnapshot(db, seeded.orderId, { lock: false });
    codes = availableStaffActions(snapshot!, 'seller', settings, T0).map((a) => a.code);
    expect(codes).toContain('qr');

    const noKeys = makeDeps(db, { env: { YOOKASSA_SHOP_ID: undefined } });
    const disabled = await applyTransition(noKeys, {
      orderId: seeded.orderId,
      event: 'handover_payment_requested',
      actor: staff,
    });
    expect(disabled).toMatchObject({ ok: false, failed: ['payments_disabled'] });

    const qr = await performStaffAction(deps, {
      staff: { id: null, role: 'seller', via: 'bot' },
      action: 'qr',
      targetId: seeded.orderId,
    });
    expect(qr.ok).toBe(true);
    const order = await orderRow(db, seeded.orderId);
    expect(order.status).toBe('awaiting_handover_payment');
    expect(order.expiresAt?.getTime()).toBe(T0.getTime() + settings.handoverQrTtlMin * 60_000);
    snapshot = await loadOrderSnapshot(db, seeded.orderId, { lock: false });
    const payment = snapshot!.payments[0]!;
    expect(payment).toMatchObject({
      kind: 'full',
      status: 'pending',
      confirmationType: 'qr',
      amountKop: seeded.totalKop,
    });
    expect(payment.request).toMatchObject({
      confirmation: 'qr',
      metadata: { payment_row_id: payment.id },
    });
    expect(snapshot!.receipts.map((r) => r.kind)).toEqual(['full']);
    expect((await outboxOf(db, seeded.orderId)).map((r) => r.jobId)).toContain(
      `payment-create:${payment.id}`,
    );
    const handed = availableStaffActions(snapshot!, 'seller', settings, T0).find(
      (a) => a.code === 'handed',
    );
    expect(handed).toMatchObject({ enabled: false, disabledReason: 'Ждём оплату' });
  });

  it('«Оплатить заранее» and its canceled payment keep the storage window', async () => {
    const seeded = await seedOrder(db, {
      scheme: 'pay_on_handover',
      status: 'ready',
      receivedAt: new Date(T0.getTime() - DAY),
      payment: null,
    });
    const settings = await loadOrderSettings(db, deps.env);
    const prepay = await performClientAction(deps, {
      orderId: seeded.orderId,
      userId: seeded.userId,
      action: 'prepay_now',
    });
    expect(prepay).toMatchObject({ ok: true, to: 'awaiting_payment' });
    let order = await orderRow(db, seeded.orderId);
    expect(order.paymentScheme).toBe('prepay');
    expect(order.expiresAt?.getTime()).toBe(T0.getTime() + settings.paymentTtlMin * 60_000);

    const expired = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'payment_ttl_expired',
      actor: system,
      facts: { providerPaymentStatus: null },
    });
    expect(expired).toMatchObject({ ok: true, to: 'ready' });
    order = await orderRow(db, seeded.orderId);
    expect(order.paymentScheme).toBe('pay_on_handover');
    expect(order.expiresAt?.getTime()).toBe(
      T0.getTime() - DAY + settings.pickupWindowCodDays * DAY,
    );
  });

  it('prepay_invoice: awaiting_supplier_invoice, «Счёт оплачен» by the owner, promised date with lag', async () => {
    const restore = await setSetting(db, 'rossko.prepay_invoice', true);
    try {
      const seeded = await seedOrder(db, { status: 'ordering' });
      await db.insert(supplierOrders).values({
        orderId: seeded.orderId,
        attemptNo: 1,
        status: 'created',
        invoiceNumber: 'INV-1',
      });
      const settings = await loadOrderSettings(db, deps.env);
      const result = await applyTransition(deps, {
        orderId: seeded.orderId,
        event: 'supplier_checkout_succeeded',
        actor: system,
        facts: { supplierItemErrors: 0 },
      });
      expect(result).toMatchObject({ ok: true, to: 'awaiting_supplier_invoice' });
      let order = await orderRow(db, seeded.orderId);
      // max eta 2026-10-08 + buffer + invoice lag
      const lag = settings.eta.bufferDays + settings.eta.invoiceLagDays;
      const expected = new Date(Date.UTC(2026, 9, 8 + lag)).toISOString().slice(0, 10);
      expect(order.promisedDate).toBe(expected);

      const seller = await performStaffAction(deps, {
        staff: { id: null, role: 'seller', via: 'bot' },
        action: 'invpaid',
        targetId: seeded.orderId,
        input: { paymentRef: 'п/п 15 от 05.10.2026' },
      });
      expect(seller).toMatchObject({ ok: false, message: 'Только владелец' });
      const paid = await performStaffAction(deps, {
        staff: { id: null, role: 'owner', via: 'admin' },
        action: 'invpaid',
        targetId: seeded.orderId,
        input: { paymentRef: 'п/п 15 от 05.10.2026' },
      });
      expect(paid.ok).toBe(true);
      order = await orderRow(db, seeded.orderId);
      expect(order.status).toBe('ordered_at_supplier');
      const [attempt] = await db
        .select()
        .from(supplierOrders)
        .where(eq(supplierOrders.orderId, seeded.orderId));
      expect(attempt).toMatchObject({ invoicePaymentRef: 'п/п 15 от 05.10.2026' });
      expect(attempt?.invoicePaidAt).not.toBeNull();
      const [event] = await db
        .select()
        .from(orderEvents)
        .where(
          and(
            eq(orderEvents.orderId, seeded.orderId),
            eq(orderEvents.type, 'supplier_invoice_paid'),
          ),
        );
      expect(event).toMatchObject({ actorId: 'admin' });
    } finally {
      await restore();
    }
  });

  it('claim_opened keeps the status and journals claim_deferred (claims are 1C)', async () => {
    const seeded = await seedOrder(db, { status: 'handed' });
    const result = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'claim_opened',
      actor: { type: 'client', id: seeded.userId },
    });
    expect(result).toMatchObject({
      ok: true,
      from: 'handed',
      to: 'handed',
      effects: ['open_claim'],
    });
    const types = (await eventsOf(db, seeded.orderId)).map((e) => e.type);
    expect(types).toEqual(['claim_opened', 'claim_deferred']);
  });

  it('a failing effect rolls back the item writes of the transition (savepoint)', async () => {
    const seeded = await seedOrder(db, { status: 'needs_attention' });
    // The payment has no provider id: no refund can be created for it.
    await db
      .update(payments)
      .set({ providerPaymentId: null })
      .where(eq(payments.id, seeded.paymentId!));
    const result = await applyTransition(deps, {
      orderId: seeded.orderId,
      event: 'item_cancelled',
      actor: staff,
      itemId: seeded.itemIds[1],
    });
    expect(result).toEqual({
      ok: false,
      reason: 'guard_failed',
      failed: ['no_refundable_payment'],
      status: 'needs_attention',
    });
    expect((await itemRows(db, seeded.orderId)).map((i) => i.state)).toEqual([
      'pending',
      'pending',
    ]);
    expect(await eventsOf(db, seeded.orderId)).toHaveLength(0);
    expect(await outboxOf(db, seeded.orderId)).toHaveLength(0);
  });

  it('an item event about a foreign item fails without writes', async () => {
    const a = await seedOrder(db, { status: 'ordered_at_supplier' });
    const b = await seedOrder(db, { status: 'ordered_at_supplier' });
    const result = await applyTransition(deps, {
      orderId: a.orderId,
      event: 'item_arrived',
      actor: owner,
      itemId: b.itemIds[0],
    });
    expect(result).toMatchObject({ ok: false, failed: ['item'] });
    expect(await eventsOf(db, a.orderId)).toHaveLength(0);
  });
});
