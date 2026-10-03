// Installation bookings (decision С6; section 5.3): slots from the order's date, the race of two
// bookings for the last lift of an hour, one active booking per order, the client's cancellation
// not later than 2 hours before, staff decisions with the journal and the client notifications.
// No price anywhere.
import { randomUUID } from 'node:crypto';
import { eq, installBookings, orders, sql, type Db } from '@detaly/db';
import { parseWorkHours } from '@detaly/domain';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bookInstall,
  cancelInstall,
  decideInstall,
  installSlotsForOrder,
  loadBookingsView,
  loadInstallLoad,
  performStaffAction,
  type ActorRef,
  type EngineDeps,
} from '../src';
import {
  DB_URL,
  eventsOf,
  makeDeps,
  openDb,
  outboxOf,
  PHASE_1C_ENV,
  seedOrder,
  testClock,
  type TestClock,
} from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SCHEDULE = parseWorkHours(PHASE_1C_ENV.PICKUP_HOURS);
const owner = { id: null, role: 'owner' as const, via: 'admin' as const };

/** 'YYYY-MM-DD' at local HH:00 (Asia/Yekaterinburg, UTC+5). */
function local(date: string, hour: number): Date {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+05:00`);
}

describe.skipIf(!DB_URL)('installation bookings', () => {
  let db: Db;
  let clock: TestClock;
  let deps: EngineDeps;

  beforeAll(() => {
    db = openDb();
    clock = testClock();
    deps = makeDeps(db, { clock, env: PHASE_1C_ENV });
  });
  afterAll(async () => {
    await db?.close();
  });

  /** A ready order of its own client; the clock at 12:00 local of `date`. */
  async function readyOrder(date: string) {
    clock.now = local(date, 12);
    const seeded = await seedOrder(db, { status: 'ready' });
    const client: ActorRef = { type: 'client', id: seeded.userId };
    return { ...seeded, client };
  }

  it('install_bookings has no price column', async () => {
    const rows = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns where table_name = 'install_bookings'`,
    );
    const names = [...rows].map((r) => r.column_name);
    expect(names).toContain('slot_at');
    expect(names.filter((n) => /kop|price|amount|sum/.test(n))).toEqual([]);
  });

  it('slots of a ready order start at now + lead; reasons when there are none', async () => {
    const order = await readyOrder('2026-10-06');
    const result = await installSlotsForOrder(db, {
      orderId: order.orderId,
      now: clock.now,
      schedule: SCHEDULE,
    });
    expect(result.reason).toBeUndefined();
    expect(result.slots).toHaveLength(6);
    expect(result.slots[0]).toMatchObject({
      startAt: '2026-10-06T13:00:00+05:00',
      endAt: '2026-10-06T15:00:00+05:00',
      timeText: '13:00',
    });
    expect(JSON.stringify(result)).not.toMatch(/kop|price/i);

    expect(
      await installSlotsForOrder(db, { orderId: order.orderId, now: clock.now, schedule: null }),
    ).toEqual({ slots: [], reason: 'no_hours' });

    // On its way without a pickup date: no_date; with one: from that day at the arrival time.
    const onWay = await seedOrder(db, { status: 'ordered_at_supplier' });
    expect(
      await installSlotsForOrder(db, {
        orderId: onWay.orderId,
        now: clock.now,
        schedule: SCHEDULE,
      }),
    ).toEqual({ slots: [], reason: 'no_date' });
    await db.update(orders).set({ promisedDate: '2026-10-08' }).where(eq(orders.id, onWay.orderId));
    const dated = await installSlotsForOrder(db, {
      orderId: onWay.orderId,
      now: clock.now,
      schedule: SCHEDULE,
      limit: 2,
    });
    expect(dated.slots.map((s) => s.startAt)).toEqual([
      '2026-10-08T12:00:00+05:00',
      '2026-10-08T13:00:00+05:00',
    ]);

    const cancelled = await seedOrder(db, { status: 'cancelled', payment: null });
    expect(
      await installSlotsForOrder(db, {
        orderId: cancelled.orderId,
        now: clock.now,
        schedule: SCHEDULE,
      }),
    ).toEqual({ slots: [], reason: 'status' });
  });

  it('two bookings racing for the last lift of an hour: one ok, one slot_taken', async () => {
    const date = '2026-10-07';
    const holder = await readyOrder(date);
    const slotAt = local(date, 13);
    const held = await bookInstall(deps, {
      orderId: holder.orderId,
      slotAt,
      via: 'web',
      requestKey: uuidv7(),
      actor: holder.client,
    });
    expect(held).toMatchObject({ ok: true, duplicate: false });

    const a = await readyOrder(date);
    const b = await readyOrder(date);
    const [ra, rb] = await Promise.all(
      [a, b].map((order) =>
        bookInstall(makeDeps(db, { clock, env: PHASE_1C_ENV }), {
          orderId: order.orderId,
          slotAt: slotAt.toISOString(),
          via: 'web',
          requestKey: uuidv7(),
          actor: order.client,
        }),
      ),
    );
    const outcomes = [ra, rb].map((r) => (r?.ok ? 'ok' : r?.reason)).sort();
    expect(outcomes).toEqual(['ok', 'slot_taken']);
    const load = await loadInstallLoad(db, { from: local(date, 0), to: local(date, 23) });
    expect(load(local(date, 13).getTime())).toEqual({ booked: 2, capacity: 2 });
    expect(load(local(date, 14).getTime())).toEqual({ booked: 2, capacity: 2 });
    expect(load(local(date, 15).getTime())).toEqual({ booked: 0, capacity: 2 });

    // The loser gets the next free slots; 13:00 is gone for everyone.
    const loser = ra?.ok ? b : a;
    const next = await installSlotsForOrder(db, {
      orderId: loser.orderId,
      now: clock.now,
      schedule: SCHEDULE,
      limit: 1,
    });
    expect(next.slots[0]?.startAt).toBe('2026-10-07T15:00:00+05:00');
  });

  it('booking: journal, outbox to the sellers and the client, request key, one active per order', async () => {
    const date = '2026-10-08';
    const order = await readyOrder(date);
    const requestKey = uuidv7();
    const input = {
      orderId: order.orderId,
      slotAt: local(date, 15),
      via: 'bot' as const,
      requestKey,
      actor: order.client,
    };
    const booked = await bookInstall(deps, input);
    if (!booked.ok) throw new Error(`booking failed: ${booked.reason}`);
    expect(booked.slot).toMatchObject({ startAt: '2026-10-08T15:00:00+05:00', timeText: '15:00' });
    // The same press again: the same booking, nothing new.
    expect(await bookInstall(deps, input)).toEqual({ ...booked, duplicate: true });
    expect(
      await bookInstall(deps, { ...input, slotAt: local(date, 16), requestKey: uuidv7() }),
    ).toEqual({ ok: false, reason: 'already_booked' });
    expect(
      await installSlotsForOrder(db, {
        orderId: order.orderId,
        now: clock.now,
        schedule: SCHEDULE,
      }),
    ).toEqual({ slots: [], reason: 'booked' });

    const rows = await db
      .select()
      .from(installBookings)
      .where(eq(installBookings.orderId, order.orderId));
    expect(rows).toEqual([
      expect.objectContaining({
        status: 'requested',
        createdVia: 'bot',
        requestKey,
        userId: order.userId,
        slotAt: local(date, 15),
      }),
    ]);
    const events = await eventsOf(db, order.orderId);
    expect(events.map((e) => e.type)).toEqual(['install_requested']);
    expect(events[0]?.payload).toMatchObject({ bookingId: booked.bookingId, via: 'bot' });
    const notify = (await outboxOf(db, order.orderId)).filter((r) => r.queue === 'notify');
    expect(notify.map((r) => (r.data as { audience: string; template: string }).template)).toEqual([
      'staff_install_request',
      'install_requested',
    ]);
  });

  it('refuses a slot off the grid, someone else’s order, a closed order and bookings when off', async () => {
    const date = '2026-10-09';
    const order = await readyOrder(date);
    const base = { orderId: order.orderId, via: 'web' as const, actor: order.client };
    expect(
      await bookInstall(deps, {
        ...base,
        slotAt: new Date(local(date, 13).getTime() + 30 * 60_000),
        requestKey: uuidv7(),
      }),
    ).toEqual({ ok: false, reason: 'bad_slot' });
    // Before now + lead (12:00 now, 13:00 is the first start).
    expect(
      await bookInstall(deps, { ...base, slotAt: local(date, 12), requestKey: uuidv7() }),
    ).toEqual({ ok: false, reason: 'bad_slot' });
    expect(
      await bookInstall(deps, { ...base, slotAt: 'not a date', requestKey: uuidv7() }),
    ).toEqual({ ok: false, reason: 'bad_slot' });
    expect(
      await bookInstall(deps, {
        ...base,
        slotAt: local(date, 13),
        requestKey: uuidv7(),
        actor: { type: 'client', id: randomUUID() },
      }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
    const off = makeDeps(db, { clock, env: { ...PHASE_1C_ENV, INSTALL_PARTNER_NAME: undefined } });
    expect(
      await bookInstall(off, { ...base, slotAt: local(date, 13), requestKey: uuidv7() }),
    ).toEqual({ ok: false, reason: 'not_allowed' });

    const cancelled = await seedOrder(db, { status: 'cancelled', payment: null });
    expect(
      await bookInstall(deps, {
        orderId: cancelled.orderId,
        slotAt: local(date, 13),
        via: 'web',
        requestKey: uuidv7(),
        actor: { type: 'client', id: cancelled.userId },
      }),
    ).toEqual({ ok: false, reason: 'not_allowed' });
    expect(await eventsOf(db, order.orderId)).toEqual([]);
  });

  it('the client cancels not later than 2 hours before the slot', async () => {
    const date = '2026-10-12';
    const order = await readyOrder(date);
    const late = await bookInstall(deps, {
      orderId: order.orderId,
      slotAt: local(date, 13),
      via: 'web',
      requestKey: uuidv7(),
      actor: order.client,
    });
    if (!late.ok) throw new Error(late.reason);
    // 12:00 now, the slot at 13:00: one hour left.
    expect(
      await cancelInstall(deps, { bookingId: late.bookingId, actor: order.client }),
    ).toMatchObject({
      ok: false,
      reason: 'too_late',
    });
    // A stranger or staff cannot cancel it this way.
    expect(
      await cancelInstall(deps, {
        bookingId: late.bookingId,
        actor: { type: 'client', id: randomUUID() },
      }),
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(
      await cancelInstall(deps, {
        bookingId: late.bookingId,
        actor: { type: 'staff', id: null, staffRole: 'owner' },
      }),
    ).toMatchObject({ ok: false, reason: 'not_allowed' });

    // Declined by the master, then booked again three hours ahead and cancelled in time.
    expect(
      await decideInstall(deps, { bookingId: late.bookingId, decision: 'decline', staff: owner }),
    ).toMatchObject({ ok: true });
    const again = await bookInstall(deps, {
      orderId: order.orderId,
      slotAt: local(date, 15),
      via: 'web',
      requestKey: uuidv7(),
      actor: order.client,
    });
    if (!again.ok) throw new Error(again.reason);
    const cancelled = await cancelInstall(deps, {
      bookingId: again.bookingId,
      actor: order.client,
    });
    expect(cancelled).toEqual({ ok: true, bookingId: again.bookingId, orderId: order.orderId });
    expect(
      await cancelInstall(deps, { bookingId: again.bookingId, actor: order.client }),
    ).toMatchObject({ ok: false, reason: 'closed' });
    const types = (await eventsOf(db, order.orderId)).map((e) => e.type);
    expect(types).toEqual([
      'install_requested',
      'install_declined',
      'install_requested',
      'install_cancelled',
    ]);
    const cancelNotify = (await outboxOf(db, order.orderId)).filter(
      (r) => r.queue === 'notify' && (r.data as { note?: string }).note !== undefined,
    );
    expect(cancelNotify.map((r) => r.data)).toEqual([
      expect.objectContaining({
        audience: 'sellers',
        template: 'staff_install_request',
        note: 'Клиент отменил запись на установку',
      }),
    ]);
  });

  it('staff decisions: confirm -> client install_confirmed; done only after the slot started', async () => {
    const date = '2026-10-13';
    const order = await readyOrder(date);
    const booked = await bookInstall(deps, {
      orderId: order.orderId,
      slotAt: local(date, 14),
      via: 'web',
      requestKey: uuidv7(),
      actor: order.client,
    });
    if (!booked.ok) throw new Error(booked.reason);
    const seller = { id: null, role: 'seller' as const, via: 'bot' as const };
    const confirmed = await performStaffAction(deps, {
      staff: seller,
      action: 'bconf',
      targetId: booked.bookingId,
    });
    expect(confirmed).toMatchObject({
      ok: true,
      message: 'Запись подтверждена',
      orderId: order.orderId,
    });
    expect(
      await performStaffAction(deps, {
        staff: seller,
        action: 'bconf',
        targetId: booked.bookingId,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await decideInstall(deps, { bookingId: booked.bookingId, decision: 'done', staff: seller }),
    ).toMatchObject({ ok: false, message: 'Время записи ещё не наступило' });
    clock.now = local(date, 16);
    expect(
      await decideInstall(deps, {
        bookingId: booked.bookingId,
        decision: 'done',
        note: 'поставили',
        staff: seller,
      }),
    ).toMatchObject({ ok: true });
    const [row] = await db
      .select()
      .from(installBookings)
      .where(eq(installBookings.id, booked.bookingId));
    expect(row).toMatchObject({ status: 'done', staffNote: 'поставили' });
    expect(row?.confirmedAt).not.toBeNull();

    const templates = (await outboxOf(db, order.orderId))
      .filter((r) => r.queue === 'notify')
      .map((r) => (r.data as { template: string }).template);
    expect(templates).toEqual(['staff_install_request', 'install_requested', 'install_confirmed']);
    const types = (await eventsOf(db, order.orderId)).map((e) => e.type);
    expect(types).toEqual(['install_requested', 'install_confirmed', 'install_done']);

    const views = await loadBookingsView(db, order.orderId);
    expect(views).toEqual([
      expect.objectContaining({
        id: booked.bookingId,
        status: 'done',
        active: false,
        slot: expect.objectContaining({ timeText: '14:00' }),
        clientCancelUntil: local(date, 12),
      }),
    ]);
    expect(JSON.stringify(views)).not.toMatch(/kop|price/i);
  });

  it('no_show and the day after: a booking no longer holds the lift', async () => {
    const date = '2026-10-14';
    const order = await readyOrder(date);
    const booked = await bookInstall(deps, {
      orderId: order.orderId,
      slotAt: local(date, 13),
      via: 'admin',
      requestKey: uuidv7(),
      actor: { type: 'staff', id: 'admin', staffRole: 'owner' },
    });
    if (!booked.ok) throw new Error(booked.reason);
    clock.advance(DAY);
    expect(
      await decideInstall(deps, { bookingId: booked.bookingId, decision: 'no_show', staff: owner }),
    ).toMatchObject({ ok: true });
    const load = await loadInstallLoad(db, { from: local(date, 0), to: local(date, 23) });
    expect(load(local(date, 13).getTime()).booked).toBe(0);
  });
});
