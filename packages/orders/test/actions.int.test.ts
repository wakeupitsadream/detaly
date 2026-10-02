// Staff and client actions on the real database: «Проверить и заказать» (journal + outbox, no
// status change), owner-only actions, manual supplier order, supplier returns and stock, the
// owner's payment refund, client actions.
import {
  and,
  eq,
  orderEvents,
  refunds,
  stockItems,
  supplierOrders,
  supplierReturns,
  type Db,
} from '@detaly/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadStaffActions, performClientAction, performStaffAction, type EngineDeps } from '../src';
import {
  assertNoPhone,
  DB_URL,
  eventsOf,
  itemRows,
  makeDeps,
  openDb,
  orderRow,
  outboxOf,
  seedOrder,
} from './helpers';

const seller = { id: null, role: 'seller' as const, via: 'bot' as const };
const admin = { id: null, role: 'owner' as const, via: 'admin' as const };

describe.skipIf(!DB_URL)('staff and client actions', () => {
  let db: Db;
  let deps: EngineDeps;

  beforeAll(() => {
    db = openDb();
    deps = makeDeps(db);
  });
  afterAll(async () => {
    await db?.close();
  });

  it('«Проверить и заказать»: journal recheck_requested and rossko/recheck, status kept', async () => {
    const seeded = await seedOrder(db, { status: 'confirmed' });
    const result = await performStaffAction(deps, {
      staff: seller,
      action: 'recheck',
      targetId: seeded.orderId,
    });
    expect(result).toEqual({
      ok: true,
      message: 'Проверяем цены и наличие у Rossko…',
      orderId: seeded.orderId,
    });
    expect((await orderRow(db, seeded.orderId)).status).toBe('confirmed');
    const events = await eventsOf(db, seeded.orderId);
    expect(events).toEqual([
      expect.objectContaining({ type: 'recheck_requested', fromStatus: null, toStatus: null }),
    ]);
    const box = await outboxOf(db, seeded.orderId);
    expect(box).toEqual([
      expect.objectContaining({
        queue: 'rossko',
        name: 'recheck',
        jobId: `recheck:${events[0]!.id}`,
        data: { orderId: seeded.orderId, eventId: events[0]!.id, staffId: null },
      }),
    ]);

    const other = await seedOrder(db, { status: 'ordered_at_supplier' });
    const refused = await performStaffAction(deps, {
      staff: seller,
      action: 'recheck',
      targetId: other.orderId,
    });
    expect(refused.ok).toBe(false);
    expect(await outboxOf(db, other.orderId)).toHaveLength(0);
    expect(await eventsOf(db, other.orderId)).toHaveLength(0);
  });

  it('unknown targets and malformed ids are refused without queries failing', async () => {
    const bad = await performStaffAction(deps, { staff: seller, action: 'came', targetId: 'x' });
    expect(bad).toMatchObject({ ok: false, message: 'Заказ не найден' });
  });

  it('«Проблема с позицией»: a menu first, then needs_attention; «Заказать всё равно» resumes', async () => {
    const seeded = await seedOrder(db, { status: 'ordered_at_supplier' });
    const itemId = seeded.itemIds[1]!;
    const menu = await performStaffAction(deps, {
      staff: seller,
      action: 'iprob',
      targetId: itemId,
    });
    expect(menu.ok).toBe(false);
    expect(menu.menu?.map((m) => m.label)).toEqual([
      'Отказ поставщика',
      'Приехало не то',
      'Повреждено при приёмке',
      'Сдвиг срока',
    ]);
    const problem = await performStaffAction(deps, {
      staff: seller,
      action: 'iprob',
      targetId: itemId,
      input: { problem: 'delay' },
    });
    expect(problem.ok).toBe(true);
    expect(await orderRow(db, seeded.orderId)).toMatchObject({
      status: 'needs_attention',
      attentionReason: 'item_problem:delay',
    });
    const actions = await loadStaffActions(deps, seeded.orderId, 'seller');
    expect(actions?.map((a) => a.code)).toEqual(
      expect.arrayContaining(['anyway', 'ialt', 'ieta', 'icancel', 'cancel', 'refused']),
    );
    const anyway = await performStaffAction(deps, {
      staff: seller,
      action: 'anyway',
      targetId: seeded.orderId,
    });
    expect(anyway.ok).toBe(true);
    expect(await orderRow(db, seeded.orderId)).toMatchObject({
      status: 'ordered_at_supplier',
      attentionReason: null,
    });
  });

  it('«Новый срок» without a date offers +2/+5/+7/+14 days', async () => {
    const seeded = await seedOrder(db, { status: 'needs_attention' });
    const menu = await performStaffAction(deps, {
      staff: seller,
      action: 'ieta',
      targetId: seeded.itemIds[0]!,
    });
    expect(menu.ok).toBe(false);
    expect(menu.menu).toHaveLength(4);
    expect(menu.menu?.[0]?.label).toMatch(/^\+2 дн\. \(2026-10-07\)$/);
  });

  it('owner-only actions are refused to sellers', async () => {
    const seeded = await seedOrder(db, { status: 'needs_attention' });
    for (const action of [
      'invpaid',
      'manual_supplier_order',
      'supplier_return_reject',
      'refund_payment',
    ] as const) {
      const result = await performStaffAction(deps, {
        staff: seller,
        action,
        targetId: seeded.orderId,
      });
      expect(result).toMatchObject({ ok: false, message: 'Только владелец' });
    }
  });

  it('«Заказано вручную в ЛК Rossko» covers pending items and closes a sending attempt', async () => {
    const seeded = await seedOrder(db, {
      status: 'needs_attention',
      attentionReason: 'unknown_after_timeout',
    });
    await db
      .insert(supplierOrders)
      .values({ orderId: seeded.orderId, attemptNo: 1, status: 'sending' });
    const empty = await performStaffAction(deps, {
      staff: admin,
      action: 'manual_supplier_order',
      targetId: seeded.orderId,
      input: { rosskoOrderIds: [' '] },
    });
    expect(empty.ok).toBe(false);
    const result = await performStaffAction(deps, {
      staff: admin,
      action: 'manual_supplier_order',
      targetId: seeded.orderId,
      input: { rosskoOrderIds: ['R-100', 'R-101'] },
    });
    expect(result.ok).toBe(true);
    const attempts = await db
      .select()
      .from(supplierOrders)
      .where(eq(supplierOrders.orderId, seeded.orderId))
      .orderBy(supplierOrders.attemptNo);
    expect(attempts.map((a) => [a.attemptNo, a.status])).toEqual([
      [1, 'failed'],
      [2, 'created'],
    ]);
    expect(attempts[1]?.rosskoOrderIds).toEqual(['R-100', 'R-101']);
    expect((await itemRows(db, seeded.orderId)).map((i) => i.state)).toEqual([
      'ordered',
      'ordered',
    ]);
    const anyway = await performStaffAction(deps, {
      staff: admin,
      action: 'anyway',
      targetId: seeded.orderId,
    });
    expect(anyway.ok).toBe(true);
    expect((await orderRow(db, seeded.orderId)).status).toBe('ordered_at_supplier');
    const [manual] = await db
      .select()
      .from(orderEvents)
      .where(
        and(eq(orderEvents.orderId, seeded.orderId), eq(orderEvents.type, 'supplier_order_manual')),
      );
    expect(manual).toMatchObject({ actorId: 'admin' });
  });

  it('Rossko did not take a return back -> stock_items; a decided return cannot change', async () => {
    const seeded = await seedOrder(db, { status: 'refund_pending' });
    const [ret] = await db
      .insert(supplierReturns)
      .values({ orderItemId: seeded.itemIds[0]!, kind: 'return', amountExpectedKop: 100_000 })
      .returning();
    const result = await performStaffAction(deps, {
      staff: admin,
      action: 'supplier_return_reject',
      targetId: seeded.orderId,
      input: { supplierReturnId: ret!.id },
    });
    expect(result.ok).toBe(true);
    const [stock] = await db
      .select()
      .from(stockItems)
      .where(eq(stockItems.orderItemId, seeded.itemIds[0]!));
    expect(stock).toMatchObject({ costKop: 100_000, reason: 'rossko_rejected_return' });
    expect((await eventsOf(db, seeded.orderId)).map((e) => e.type)).toEqual(['stock_item_created']);
    const again = await performStaffAction(deps, {
      staff: admin,
      action: 'supplier_return_accept',
      targetId: seeded.orderId,
      input: { supplierReturnId: ret!.id, amountKop: 100_000 },
    });
    expect(again).toMatchObject({ ok: false, message: 'Решение по возврату уже записано' });
  });

  it('«Вернуть платёж» (owner): an orphan refund of the whole payment with the reason', async () => {
    const seeded = await seedOrder(db, {
      status: 'needs_attention',
      attentionReason: 'amount_mismatch',
    });
    const noReason = await performStaffAction(deps, {
      staff: admin,
      action: 'refund_payment',
      targetId: seeded.orderId,
      input: { paymentId: seeded.paymentId! },
    });
    expect(noReason.ok).toBe(false);
    const result = await performStaffAction(deps, {
      staff: admin,
      action: 'refund_payment',
      targetId: seeded.orderId,
      input: { paymentId: seeded.paymentId!, reason: 'Дубль оплаты' },
    });
    expect(result.ok).toBe(true);
    const rows = await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId));
    expect(rows).toEqual([
      expect.objectContaining({
        scope: 'orphan',
        reason: 'amount_mismatch',
        amountKop: seeded.totalKop,
      }),
    ]);
    expect((await orderRow(db, seeded.orderId)).status).toBe('needs_attention');
    const twice = await performStaffAction(deps, {
      staff: admin,
      action: 'refund_payment',
      targetId: seeded.orderId,
      input: { paymentId: seeded.paymentId!, reason: 'Дубль оплаты' },
    });
    expect(twice.ok).toBe(false);
    expect(await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId))).toHaveLength(
      1,
    );
    assertNoPhone(await eventsOf(db, seeded.orderId), seeded.phone);
  });

  it('client actions: only the order owner; «Отказаться» before confirmation cancels', async () => {
    const seeded = await seedOrder(db, {
      scheme: 'pay_on_handover',
      status: 'awaiting_confirmation',
      payment: null,
    });
    const stranger = await performClientAction(deps, {
      orderId: seeded.orderId,
      userId: '0190d1b0-0000-7000-8000-000000000001',
      action: 'refuse',
    });
    expect(stranger).toEqual({ ok: false, reason: 'not_found', failed: [], status: null });
    const refused = await performClientAction(deps, {
      orderId: seeded.orderId,
      userId: seeded.userId,
      action: 'refuse',
    });
    expect(refused).toMatchObject({ ok: true, to: 'cancelled' });
    expect((await eventsOf(db, seeded.orderId))[0]?.type).toBe('client_cancelled');
  });

  it('client «Отменить позицию» of an unpaid pay_on_handover order: item failed, total shrinks', async () => {
    const seeded = await seedOrder(db, {
      scheme: 'pay_on_handover',
      status: 'ordered_at_supplier',
      payment: null,
    });
    const result = await performClientAction(deps, {
      orderId: seeded.orderId,
      userId: seeded.userId,
      action: 'item_cancel',
      itemId: seeded.itemIds[1]!,
    });
    expect(result).toMatchObject({ ok: true, to: 'ordered_at_supplier' });
    expect((await itemRows(db, seeded.orderId)).map((i) => i.state)).toEqual(['ordered', 'failed']);
    expect(await orderRow(db, seeded.orderId)).toMatchObject({
      subtotalKop: 128_000,
      totalKop: 128_000,
    });
    expect(await db.select().from(refunds).where(eq(refunds.orderId, seeded.orderId))).toHaveLength(
      0,
    );
  });
});
