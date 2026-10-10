// Step 7 (docs/month-close.md): supplier returns to the end on the real database — «Сдал
// водителю», «Не берут» (one stock row at the cost of the order), «Деньги вернулись», «Списать»;
// idempotent presses, any staff member, the owner's admin decisions after «Сдал водителю», the
// buttons of the bot card and the order of /admin/returns.
import { eq, orderEvents, orders, stockItems, supplierReturns, type Db } from '@detaly/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listStockItems,
  listSupplierReturns,
  loadOrderSupplierReturns,
  markSupplierReturnRefunded,
  performStaffAction,
  rejectSupplierReturn,
  shipSupplierReturn,
  sortSupplierReturns,
  STOCK_REASON_NOT_ACCEPTED,
  supplierReturnActions,
  supplierReturnUrgency,
  writeOffStockItem,
  type EngineDeps,
  type SupplierReturnView,
} from '../src';
import {
  assertNoPhone,
  DB_URL,
  eventsOf,
  makeDeps,
  openDb,
  seedOrder,
  T0,
  testClock,
  type TestClock,
} from './helpers';

const seller = { id: null, role: 'seller' as const, via: 'bot' as const };
const admin = { id: null, role: 'owner' as const, via: 'admin' as const };
const DAY = 86_400_000;

describe.skipIf(!DB_URL)('supplier returns to the end', () => {
  let db: Db;
  let deps: EngineDeps;
  let clock: TestClock;
  const nudges = { count: 0 };

  beforeAll(() => {
    db = openDb();
    clock = testClock();
    deps = makeDeps(db, { clock, nudges });
  });
  afterAll(async () => {
    await db?.close();
  });

  /** A no-show order with one waiting return: 2 × MANN at 1 000 ₽ wholesale each. */
  async function waitingReturn(deadline: Date | null = new Date(T0.getTime() + 5 * DAY)) {
    const seeded = await seedOrder(db, {
      status: 'refund_pending',
      items: [
        {
          brand: 'MANN',
          article: 'W 914/2',
          qty: 2,
          priceClientKop: 128_000,
          priceSupplierKop: 100_000,
          state: 'arrived',
        },
      ],
    });
    await db
      .update(orders)
      .set({ supplierReturnDeadlineAt: deadline })
      .where(eq(orders.id, seeded.orderId));
    const [ret] = await db
      .insert(supplierReturns)
      .values({
        orderItemId: seeded.itemIds[0]!,
        kind: 'return',
        status: 'requested',
        amountExpectedKop: 200_000,
      })
      .returning();
    return { seeded, ret: ret! };
  }

  async function returnRow(id: string) {
    const [row] = await db.select().from(supplierReturns).where(eq(supplierReturns.id, id));
    return row!;
  }

  it('«Сдал водителю» by a seller: shipped once with shipped_at; a second press changes nothing', async () => {
    const { seeded, ret } = await waitingReturn();
    clock.now = new Date(T0.getTime() + DAY);
    const before = nudges.count;
    const first = await performStaffAction(deps, {
      staff: seller,
      action: 'srship',
      targetId: ret.id,
    });
    expect(first).toEqual({
      ok: true,
      message: 'Сдано водителю: MANN W 914/2. Ждём деньги от Rossko',
      orderId: seeded.orderId,
    });
    expect(await returnRow(ret.id)).toMatchObject({ status: 'shipped', shippedAt: clock.now });
    expect(nudges.count).toBe(before + 1);

    clock.now = new Date(T0.getTime() + 2 * DAY);
    const again = await performStaffAction(deps, {
      staff: seller,
      action: 'srship',
      targetId: ret.id,
    });
    expect(again.ok).toBe(true);
    expect(again.message).toBe('Уже отмечено: MANN W 914/2 сдан водителю 6 октября');
    expect((await returnRow(ret.id)).shippedAt).toEqual(new Date(T0.getTime() + DAY));
    const events = (await eventsOf(db, seeded.orderId)).filter(
      (e) => e.type === 'supplier_return_shipped',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: 'staff', fromStatus: null, toStatus: null });
    expect(events[0]?.payload).toMatchObject({ supplierReturnId: ret.id, via: 'bot' });
    assertNoPhone(events, seeded.phone);
  });

  it('«Не берут»: rejected and one stock row at the order cost, however often it is pressed', async () => {
    const { seeded, ret } = await waitingReturn();
    const [a, b] = await Promise.all([
      rejectSupplierReturn(deps, { supplierReturnId: ret.id, staff: seller }),
      rejectSupplierReturn(deps, { supplierReturnId: ret.id, staff: seller }),
    ]);
    expect([a, b].every((r) => r.ok)).toBe(true);
    expect([a, b].map((r) => r.message).sort()).toEqual([
      'Не берут: MANN W 914/2 — деталь на складе (2 000 ₽)',
      'Уже отмечено: MANN W 914/2 не берут, деталь на складе',
    ]);
    const again = await performStaffAction(deps, {
      staff: seller,
      action: 'srrej',
      targetId: ret.id,
    });
    expect(again.ok).toBe(true);
    expect((await returnRow(ret.id)).status).toBe('rejected');
    const stock = await db
      .select()
      .from(stockItems)
      .where(eq(stockItems.orderItemId, seeded.itemIds[0]!));
    expect(stock).toHaveLength(1);
    // cost = price_supplier_at_order × qty, the spec's reason
    expect(stock[0]).toMatchObject({ costKop: 200_000, reason: STOCK_REASON_NOT_ACCEPTED });
    const created = (await eventsOf(db, seeded.orderId)).filter(
      (e) => e.type === 'stock_item_created',
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({
      stockItemId: stock[0]?.id,
      supplierReturnId: ret.id,
      costKop: 200_000,
    });
    // A rejected return cannot be shipped any more.
    const ship = await shipSupplierReturn(deps, { supplierReturnId: ret.id, staff: seller });
    expect(ship).toMatchObject({ ok: false, message: 'MANN W 914/2: уже отмечено «Не берут»' });
  });

  it('the owner decides in the admin after «Сдал водителю»: «Rossko не принял» and «Rossko принял»', async () => {
    const shipped = await waitingReturn();
    await shipSupplierReturn(deps, { supplierReturnId: shipped.ret.id, staff: seller });
    const rejected = await performStaffAction(deps, {
      staff: admin,
      action: 'supplier_return_reject',
      targetId: shipped.seeded.orderId,
      input: { supplierReturnId: shipped.ret.id, note: 'брак упаковки' },
    });
    expect(rejected).toMatchObject({ ok: true, message: 'Возврат не принят: деталь на складе' });
    const [stock] = await db
      .select()
      .from(stockItems)
      .where(eq(stockItems.orderItemId, shipped.seeded.itemIds[0]!));
    // the admin's 1B reason code stays as it was
    expect(stock).toMatchObject({ costKop: 200_000, reason: 'rossko_rejected_return' });
    expect(await returnRow(shipped.ret.id)).toMatchObject({
      status: 'rejected',
      note: 'брак упаковки',
    });
    const twice = await performStaffAction(deps, {
      staff: admin,
      action: 'supplier_return_reject',
      targetId: shipped.seeded.orderId,
      input: { supplierReturnId: shipped.ret.id },
    });
    expect(twice).toMatchObject({ ok: false, message: 'Решение по возврату уже записано' });

    const accepted = await waitingReturn();
    await shipSupplierReturn(deps, { supplierReturnId: accepted.ret.id, staff: seller });
    const ok = await performStaffAction(deps, {
      staff: admin,
      action: 'supplier_return_accept',
      targetId: accepted.seeded.orderId,
      input: { supplierReturnId: accepted.ret.id },
    });
    expect(ok.ok).toBe(true);
    expect((await returnRow(accepted.ret.id)).status).toBe('accepted');
    // a seller may not take the owner's decisions
    const sellerTry = await performStaffAction(deps, {
      staff: seller,
      action: 'supplier_return_reject',
      targetId: accepted.seeded.orderId,
      input: { supplierReturnId: accepted.ret.id },
    });
    expect(sellerTry).toMatchObject({ ok: false, message: 'Только владелец' });
  });

  it('«Деньги вернулись»: refunded with the amount and the date; once; never after «Не берут»', async () => {
    const { seeded, ret } = await waitingReturn();
    await shipSupplierReturn(deps, { supplierReturnId: ret.id, staff: seller });
    expect(
      await markSupplierReturnRefunded(deps, {
        supplierReturnId: ret.id,
        amountKop: 0,
        staff: admin,
      }),
    ).toMatchObject({ ok: false });
    clock.now = new Date(T0.getTime() + 9 * DAY);
    const done = await markSupplierReturnRefunded(deps, {
      supplierReturnId: ret.id,
      amountKop: 195_000,
      staff: admin,
    });
    expect(done).toEqual({
      ok: true,
      message: 'Деньги вернулись: MANN W 914/2, 1 950 ₽',
      orderId: seeded.orderId,
    });
    expect(await returnRow(ret.id)).toMatchObject({
      status: 'refunded',
      amountReceivedKop: 195_000,
      refundedAt: clock.now,
    });
    const again = await markSupplierReturnRefunded(deps, {
      supplierReturnId: ret.id,
      amountKop: 1,
      staff: admin,
    });
    expect(again).toMatchObject({
      ok: true,
      message: 'Уже отмечено: за MANN W 914/2 вернулось 1 950 ₽ 14 октября',
    });
    expect((await returnRow(ret.id)).amountReceivedKop).toBe(195_000);
    const journal = (await eventsOf(db, seeded.orderId)).filter(
      (e) => e.type === 'supplier_return_refunded',
    );
    expect(journal.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        supplierReturnId: ret.id,
        amountKop: 195_000,
        expectedKop: 200_000,
      }),
    ]);

    const other = await waitingReturn();
    await rejectSupplierReturn(deps, { supplierReturnId: other.ret.id, staff: seller });
    expect(
      await markSupplierReturnRefunded(deps, {
        supplierReturnId: other.ret.id,
        amountKop: 100,
        staff: admin,
      }),
    ).toMatchObject({ ok: false, message: 'MANN W 914/2: отмечено «Не берут» — деталь на складе' });
  });

  it('«Rossko принял возврат» with the amount received is «Деньги вернулись»', async () => {
    const { seeded, ret } = await waitingReturn();
    clock.now = new Date(T0.getTime() + 3 * DAY);
    const result = await performStaffAction(deps, {
      staff: admin,
      action: 'supplier_return_accept',
      targetId: seeded.orderId,
      input: { supplierReturnId: ret.id, amountKop: 200_000 },
    });
    expect(result).toMatchObject({
      ok: true,
      message: 'Деньги вернулись: MANN W 914/2, 2\u00a0000\u00a0₽',
    });
    expect(await returnRow(ret.id)).toMatchObject({
      status: 'refunded',
      amountReceivedKop: 200_000,
      refundedAt: clock.now,
    });
    expect(
      (await eventsOf(db, seeded.orderId)).filter((e) => e.type === 'supplier_return_refunded'),
    ).toHaveLength(1);
    // A decided return is refused, as before.
    const again = await performStaffAction(deps, {
      staff: admin,
      action: 'supplier_return_accept',
      targetId: seeded.orderId,
      input: { supplierReturnId: ret.id, amountKop: 100 },
    });
    expect(again).toMatchObject({ ok: false, message: 'Решение по возврату уже записано' });
  });

  it('«Списать»: written off once; the stock list keeps it below the parts in stock', async () => {
    const { ret, seeded } = await waitingReturn();
    await rejectSupplierReturn(deps, { supplierReturnId: ret.id, staff: seller });
    const [stock] = await db
      .select()
      .from(stockItems)
      .where(eq(stockItems.orderItemId, seeded.itemIds[0]!));
    clock.now = new Date(T0.getTime() + 3 * DAY);
    const first = await writeOffStockItem(deps, { stockItemId: stock!.id, staff: admin });
    expect(first).toMatchObject({ ok: true, message: 'Списано: MANN W 914/2 (2 000 ₽)' });
    const second = await writeOffStockItem(deps, { stockItemId: stock!.id, staff: admin });
    expect(second).toMatchObject({ ok: true, message: 'Уже списано: MANN W 914/2 8 октября' });
    const [row] = await db.select().from(stockItems).where(eq(stockItems.id, stock!.id));
    expect(row?.writtenOffAt).toEqual(clock.now);
    expect(
      (await db.select().from(orderEvents).where(eq(orderEvents.orderId, seeded.orderId))).filter(
        (e) => e.type === 'stock_item_written_off',
      ),
    ).toHaveLength(1);
    const inStock = await listStockItems(db, { includeWrittenOff: false });
    expect(inStock.map((s) => s.id)).not.toContain(stock!.id);
    const all = await listStockItems(db, { includeWrittenOff: true });
    expect(all.find((s) => s.id === stock!.id)).toMatchObject({
      orderNumber: seeded.number,
      costKop: 200_000,
      writtenOffAt: clock.now,
    });
    expect(
      await writeOffStockItem(deps, {
        stockItemId: '0192f0c4-0000-7000-8000-00000000dead',
        staff: admin,
      }),
    ).toMatchObject({ ok: false, message: 'Деталь на складе не найдена' });
  });

  it('the bot card offers both buttons only while the part waits; unknown ids are refused', async () => {
    const { seeded, ret } = await waitingReturn();
    const views = await loadOrderSupplierReturns(db, seeded.orderId);
    expect(supplierReturnActions(views)).toEqual([
      expect.objectContaining({
        code: 'srship',
        label: 'Сдал водителю: MANN W 914/2',
        supplierReturnId: ret.id,
      }),
      expect.objectContaining({
        code: 'srrej',
        label: 'Не берут: MANN W 914/2',
        supplierReturnId: ret.id,
      }),
    ]);
    await shipSupplierReturn(deps, { supplierReturnId: ret.id, staff: seller });
    expect(supplierReturnActions(await loadOrderSupplierReturns(db, seeded.orderId))).toEqual([]);
    expect(
      await performStaffAction(deps, {
        staff: seller,
        action: 'srship',
        targetId: '0192f0c4-0000-7000-8000-00000000beef',
      }),
    ).toMatchObject({ ok: false, message: 'Заказ не найден' });
  });

  it('/admin/returns: overdue first, then due soon, open, waiting for the money, closed', async () => {
    const now = new Date(T0.getTime() + 10 * DAY);
    const view = (over: Partial<SupplierReturnView>): SupplierReturnView => ({
      id: 'x',
      orderId: 'o',
      orderNumber: 'DT-000001',
      orderItemId: 'i',
      brand: 'MANN',
      article: 'W 914/2',
      name: 'Фильтр',
      qty: 1,
      kind: 'return',
      status: 'requested',
      amountExpectedKop: 100,
      amountReceivedKop: null,
      note: null,
      createdAt: T0,
      shippedAt: null,
      refundedAt: null,
      updatedAt: T0,
      deadlineAt: null,
      ...over,
    });
    const rows = [
      view({ id: 'closed', status: 'refunded', updatedAt: new Date(now.getTime() - DAY) }),
      view({ id: 'money-new', status: 'shipped', shippedAt: new Date(now.getTime() - DAY) }),
      view({ id: 'money-old', status: 'shipped', shippedAt: new Date(now.getTime() - 9 * DAY) }),
      view({ id: 'open-late', deadlineAt: new Date(now.getTime() + 9 * DAY) }),
      view({ id: 'soon', deadlineAt: new Date(now.getTime() + DAY) }),
      view({ id: 'overdue', deadlineAt: new Date(now.getTime() - 1) }),
      view({ id: 'no-deadline' }),
    ];
    expect(sortSupplierReturns(rows, now).map((r) => r.id)).toEqual([
      'overdue',
      'soon',
      'open-late',
      'no-deadline',
      'money-old',
      'money-new',
      'closed',
    ]);
    expect(supplierReturnUrgency(rows[5]!, now)).toBe('overdue');

    const { ret } = await waitingReturn(new Date(clock.now.getTime() - DAY));
    const listed = await listSupplierReturns(db, {
      now: clock.now,
      closedSince: new Date(clock.now.getTime() - 30 * DAY),
    });
    const mine = listed.find((r) => r.id === ret.id);
    expect(mine).toMatchObject({ status: 'requested', orderNumber: expect.stringMatching(/^DT-/) });
    expect(supplierReturnUrgency(mine!, clock.now)).toBe('overdue');
    // The database's list comes in the order of sortSupplierReturns.
    expect(listed.map((r) => r.id)).toEqual(
      sortSupplierReturns(listed, clock.now).map((r) => r.id),
    );
  });
});
