/**
 * Installation bookings (docs/phase-1c-implementation.md decision С6). The installation is a
 * service of the partner (INSTALL_PARTNER_NAME), paid at the service by its own receipt: no price
 * is stored, computed or shown here.
 *
 * - loadInstallLoad: the one loader of the lift load from install_bookings (requested and
 *   confirmed bookings hold a lift for INSTALL_JOB_MIN); the web load source delegates to it;
 * - installSlotsForOrder: free starts (listInstallSlots) from the day the part is at the point;
 * - bookInstall: under the order row lock and pg_advisory_xact_lock, with the slot checked again
 *   against the fresh load, so two clients never get the last lift of an hour;
 * - cancelInstall (client, not later than 2 hours before the slot) and decideInstall (staff).
 */
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  installBookings,
  lt,
  orders,
  sql,
  type Executor,
} from '@detaly/db';
import {
  addDays,
  CLIENT_TIME_ZONE,
  INSTALL_BOOKABLE_STATUSES,
  INSTALL_HOLDING_STATUSES,
  installSlotOf,
  listInstallSlots,
  localDate,
  parseWorkHours,
  zonedInstant,
  type InstallBookingStatus,
  type InstallCreatedVia,
  type InstallPlan,
  type InstallSlot,
  type InstallWindowOptions,
  type IsoDate,
  type LoadSnapshot,
  type OrderStatus,
  type WeekSchedule,
} from '@detaly/domain';
import {
  INSTALL_ARRIVAL_TIME,
  INSTALL_CLIENT_CANCEL_BEFORE_MIN,
  INSTALL_HORIZON_DAYS,
  INSTALL_JOB_MIN,
  INSTALL_LEAD_MIN,
  INSTALL_LIFTS,
  INSTALL_SLOTS_SHOWN,
  INSTALL_STEP_MIN,
} from '@detaly/domain/install-params';
import { clock, nudge } from './engine';
import { enqueueNotify, recordJournalEvent } from './journal';
import { isUuid, loadOrderSnapshot } from './snapshot';
import type {
  ActorRef,
  BookInstallResult,
  BookingView,
  CancelInstallResult,
  EngineDeps,
  InstallDecision,
  InstallSlotsResult,
  ServiceResult,
  StaffRef,
  Tx,
} from './types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Every start of the horizon (the booking check looks at all of them, not the first six). */
const ALL_SLOTS = 10_000;

/** Bookings that hold a lift (requested ones too: the master has not said no yet). */
const HOLDING: readonly InstallBookingStatus[] = INSTALL_HOLDING_STATUSES;
const BOOKABLE: readonly OrderStatus[] = INSTALL_BOOKABLE_STATUSES;
/** The part is already at the point: the visit can start as soon as the lead time allows. */
const AT_POINT: readonly OrderStatus[] = ['ready', 'awaiting_handover_payment', 'handed'];

/** The planner numbers of `@detaly/domain/install-params` (the web uses the same ones). */
export const INSTALL_OPTIONS: InstallWindowOptions = {
  arrivalTime: INSTALL_ARRIVAL_TIME,
  leadMin: INSTALL_LEAD_MIN,
  jobMin: INSTALL_JOB_MIN,
  stepMin: INSTALL_STEP_MIN,
  horizonDays: INSTALL_HORIZON_DAYS,
};

// ---------------------------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------------------------

/** Load per local hour from booking start times (epoch ms): a booking holds one lift for jobMin. */
export function snapshotFromBookings(
  slotStarts: readonly number[],
  capacity: number,
  jobMin: number,
): LoadSnapshot {
  const jobMs = jobMin * MINUTE_MS;
  return (hourStartMs) => {
    const hourEnd = hourStartMs + HOUR_MS;
    let booked = 0;
    for (const start of slotStarts) {
      if (start < hourEnd && start + jobMs > hourStartMs) booked += 1;
    }
    return { booked, capacity };
  };
}

/**
 * Lift load of [from, to) from install_bookings (requested and confirmed): one query, then an
 * in-memory count per hour. The web LoadSource `live` and the booking check share it.
 */
export async function loadInstallLoad(
  db: Executor,
  input: { from: Date; to: Date; capacity?: number; jobMin?: number },
): Promise<LoadSnapshot> {
  const capacity = input.capacity ?? INSTALL_LIFTS;
  const jobMin = input.jobMin ?? INSTALL_JOB_MIN;
  const rows = await db
    .select({ slotAt: installBookings.slotAt })
    .from(installBookings)
    .where(
      and(
        // A booking that started less than jobMin before `from` still holds a lift.
        gt(installBookings.slotAt, new Date(input.from.getTime() - jobMin * MINUTE_MS)),
        lt(installBookings.slotAt, input.to),
        inArray(installBookings.status, [...HOLDING]),
      ),
    );
  return snapshotFromBookings(
    rows.map((row) => row.slotAt.getTime()),
    capacity,
    jobMin,
  );
}

// ---------------------------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------------------------

/** A booked slot as a plan (for installSlotOf). */
function slotPlan(slotAt: Date): Pick<InstallPlan, 'slotStart' | 'carReadyAt'> {
  return {
    slotStart: slotAt,
    carReadyAt: new Date(slotAt.getTime() + INSTALL_JOB_MIN * MINUTE_MS),
  };
}

/** A booking's slot as the client sees it ('чт 8 окт', '14:00'). */
export function bookingSlot(slotAt: Date, timeZone: string = CLIENT_TIME_ZONE): InstallSlot {
  return installSlotOf(slotPlan(slotAt), timeZone);
}

interface SlotBase {
  etaDate: IsoDate;
  options: InstallWindowOptions;
  from: Date;
  to: Date;
}

/**
 * Where the planner starts for an order: a part at the point — today with no arrival time (now +
 * lead); a part on its way — the promised pickup date at the arrival time. null: no date yet.
 */
function slotBase(
  order: { status: OrderStatus; promisedDate: string | null },
  now: Date,
  timeZone: string,
): SlotBase | null {
  const today = localDate(now, timeZone);
  let etaDate: IsoDate;
  let options = INSTALL_OPTIONS;
  if (AT_POINT.includes(order.status)) {
    etaDate = today;
    options = { ...INSTALL_OPTIONS, arrivalTime: '00:00' };
  } else if (order.promisedDate !== null) {
    etaDate = order.promisedDate < today ? today : order.promisedDate;
  } else {
    return null;
  }
  const to = new Date(
    zonedInstant(addDays(etaDate, options.horizonDays + 1), 0, timeZone) + DAY_MS,
  );
  return { etaDate, options, from: now, to };
}

function plan(
  base: SlotBase,
  now: Date,
  schedule: WeekSchedule,
  load: LoadSnapshot,
  limit: number,
  timeZone: string,
): InstallPlan[] {
  return listInstallSlots({
    etaDate: base.etaDate,
    now,
    timeZone,
    schedule,
    load,
    loadKind: 'live',
    options: base.options,
    limit,
  });
}

/**
 * Up to `limit` (INSTALL_SLOTS_SHOWN) free installation slots for an order, from the day its part
 * is at the point; `reason` tells why the list is empty.
 */
export async function installSlotsForOrder(
  db: Executor,
  input: {
    orderId: string;
    now: Date;
    /** parseWorkHours(PICKUP_HOURS) */
    schedule: WeekSchedule | null;
    limit?: number;
    timeZone?: string;
  },
): Promise<InstallSlotsResult> {
  const timeZone = input.timeZone ?? CLIENT_TIME_ZONE;
  if (!isUuid(input.orderId)) return { slots: [], reason: 'status' };
  const [order] = await db
    .select({ status: orders.status, promisedDate: orders.promisedDate })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (!order || !BOOKABLE.includes(order.status)) return { slots: [], reason: 'status' };
  const [active] = await db
    .select({ id: installBookings.id })
    .from(installBookings)
    .where(
      and(
        eq(installBookings.orderId, input.orderId),
        inArray(installBookings.status, [...HOLDING]),
      ),
    )
    .limit(1);
  if (active) return { slots: [], reason: 'booked' };
  if (input.schedule === null) return { slots: [], reason: 'no_hours' };
  const base = slotBase(order, input.now, timeZone);
  if (base === null) return { slots: [], reason: 'no_date' };
  const load = await loadInstallLoad(db, { from: base.from, to: base.to });
  const plans = plan(
    base,
    input.now,
    input.schedule,
    load,
    input.limit ?? INSTALL_SLOTS_SHOWN,
    timeZone,
  );
  const slots = plans.map((p) => installSlotOf(p, timeZone));
  return slots.length > 0 ? { slots } : { slots, reason: 'full' };
}

function parseSlot(value: Date | string): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Books a slot (status requested: it already holds a lift until the master answers). The slot
 * must be a start listInstallSlots offers right now with the fresh load; the request key makes a
 * repeated form or press return the same booking. Without INSTALL_PARTNER_NAME bookings are off.
 */
export async function bookInstall(
  deps: EngineDeps,
  input: {
    orderId: string;
    slotAt: Date | string;
    via: InstallCreatedVia;
    requestKey: string;
    actor: ActorRef;
    timeZone?: string;
  },
): Promise<BookInstallResult> {
  const timeZone = input.timeZone ?? CLIENT_TIME_ZONE;
  const slotAt = parseSlot(input.slotAt);
  if (slotAt === null) return { ok: false, reason: 'bad_slot' };
  if (!isUuid(input.orderId) || !isUuid(input.requestKey)) {
    return { ok: false, reason: 'not_allowed' };
  }
  if (!deps.env.INSTALL_PARTNER_NAME) return { ok: false, reason: 'not_allowed' };
  const schedule = parseWorkHours(deps.env.PICKUP_HOURS ?? null);
  if (schedule === null) return { ok: false, reason: 'bad_slot' };

  const result = await deps.db.transaction(async (tx): Promise<BookInstallResult> => {
    const snapshot = await loadOrderSnapshot(tx, input.orderId, { lock: true });
    if (snapshot === null) return { ok: false, reason: 'not_allowed' };
    const { order } = snapshot;
    const now = clock(deps);
    if (input.actor.type === 'client' && input.actor.id !== order.userId) {
      return { ok: false, reason: 'not_allowed' };
    }
    if (input.actor.type !== 'client' && input.actor.type !== 'staff') {
      return { ok: false, reason: 'not_allowed' };
    }

    const [repeated] = await tx
      .select({
        id: installBookings.id,
        orderId: installBookings.orderId,
        slotAt: installBookings.slotAt,
      })
      .from(installBookings)
      .where(eq(installBookings.requestKey, input.requestKey));
    if (repeated) {
      if (repeated.orderId !== order.id) return { ok: false, reason: 'not_allowed' };
      return {
        ok: true,
        bookingId: repeated.id,
        slot: installSlotOf(slotPlan(repeated.slotAt), timeZone),
        duplicate: true,
      };
    }
    if (!BOOKABLE.includes(order.status)) return { ok: false, reason: 'not_allowed' };
    if (snapshot.bookings.some((b) => HOLDING.includes(b.status))) {
      return { ok: false, reason: 'already_booked' };
    }
    const base = slotBase(order, now, timeZone);
    if (base === null) return { ok: false, reason: 'bad_slot' };

    // Every booking of every order waits here: the load read below sees the bookings committed
    // before this one (READ COMMITTED reads per statement).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('install_bookings'))`);
    const load = await loadInstallLoad(tx, { from: base.from, to: base.to });
    const free = plan(base, now, schedule, load, ALL_SLOTS, timeZone);
    const wanted = slotAt.getTime();
    const chosen = free.find((p) => p.slotStart.getTime() === wanted);
    if (chosen === undefined) {
      const empty = plan(
        base,
        now,
        schedule,
        () => ({ booked: 0, capacity: 1 }),
        ALL_SLOTS,
        timeZone,
      );
      const exists = empty.some((p) => p.slotStart.getTime() === wanted);
      return { ok: false, reason: exists ? 'slot_taken' : 'bad_slot' };
    }

    const [booking] = await tx
      .insert(installBookings)
      .values({
        orderId: order.id,
        userId: order.userId,
        slotAt: chosen.slotStart,
        status: 'requested',
        requestKey: input.requestKey,
        createdVia: input.via,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: installBookings.id });
    const bookingId = (booking as { id: string }).id;
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId: order.id,
      type: 'install_requested',
      actor: input.actor,
      payload: { bookingId, slotAt: chosen.slotStart.toISOString(), via: input.via },
      at: now,
    });
    await enqueueNotify(tx, {
      orderId: order.id,
      orderEventId,
      audience: 'sellers',
      template: 'staff_install_request',
    });
    await enqueueNotify(tx, {
      orderId: order.id,
      orderEventId,
      audience: 'client',
      template: 'install_requested',
    });
    return { ok: true, bookingId, slot: installSlotOf(chosen, timeZone), duplicate: false };
  });
  if (result.ok && !result.duplicate) nudge(deps);
  return result;
}

/** The booking with its order row locked (`for update` on both). */
async function lockBooking(tx: Tx, bookingId: string) {
  const [head] = await tx
    .select({ orderId: installBookings.orderId })
    .from(installBookings)
    .where(eq(installBookings.id, bookingId));
  if (!head) return null;
  const [order] = await tx
    .select({ id: orders.id, userId: orders.userId })
    .from(orders)
    .where(eq(orders.id, head.orderId))
    .for('update');
  if (!order) return null;
  const [booking] = await tx
    .select()
    .from(installBookings)
    .where(eq(installBookings.id, bookingId))
    .for('update');
  return booking ? { order, booking } : null;
}

/**
 * The client cancels their own booking, not later than INSTALL_CLIENT_CANCEL_BEFORE_MIN before
 * the slot (no 4 phone digits needed, decision С6); the sellers get the order card. Staff use
 * decideInstall('decline') instead.
 */
export async function cancelInstall(
  deps: EngineDeps,
  input: { bookingId: string; actor: ActorRef },
): Promise<CancelInstallResult> {
  if (!isUuid(input.bookingId)) {
    return { ok: false, reason: 'not_found', message: 'Запись не найдена' };
  }
  if (input.actor.type !== 'client') {
    return {
      ok: false,
      reason: 'not_allowed',
      message: 'Мастер отменяет запись кнопкой «Отклонить»',
    };
  }
  const result = await deps.db.transaction(async (tx): Promise<CancelInstallResult> => {
    const found = await lockBooking(tx, input.bookingId);
    if (found === null || found.order.userId !== input.actor.id) {
      return { ok: false, reason: 'not_found', message: 'Запись не найдена' };
    }
    const { booking, order } = found;
    if (!HOLDING.includes(booking.status)) {
      return { ok: false, reason: 'closed', message: 'Запись уже закрыта' };
    }
    const now = clock(deps);
    const until = booking.slotAt.getTime() - INSTALL_CLIENT_CANCEL_BEFORE_MIN * MINUTE_MS;
    if (now.getTime() > until) {
      return {
        ok: false,
        reason: 'too_late',
        message: 'До установки меньше 2 часов — позвоните в сервис, чтобы отменить запись',
      };
    }
    await tx
      .update(installBookings)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
      .where(eq(installBookings.id, booking.id));
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId: order.id,
      type: 'install_cancelled',
      actor: input.actor,
      payload: { bookingId: booking.id, slotAt: booking.slotAt.toISOString() },
      at: now,
    });
    await enqueueNotify(tx, {
      orderId: order.id,
      orderEventId,
      audience: 'sellers',
      template: 'staff_install_request',
      note: 'Клиент отменил запись на установку',
    });
    return { ok: true, bookingId: booking.id, orderId: order.id };
  });
  if (result.ok) nudge(deps);
  return result;
}

const DECISIONS: Record<
  InstallDecision,
  {
    from: readonly InstallBookingStatus[];
    to: InstallBookingStatus;
    journal: 'install_confirmed' | 'install_declined' | 'install_done' | 'install_no_show';
    client: 'install_confirmed' | 'install_declined' | null;
    /** Only once the slot has started. */
    afterStart: boolean;
    message: string;
  }
> = {
  confirm: {
    from: ['requested'],
    to: 'confirmed',
    journal: 'install_confirmed',
    client: 'install_confirmed',
    afterStart: false,
    message: 'Запись подтверждена',
  },
  decline: {
    from: ['requested', 'confirmed'],
    to: 'cancelled',
    journal: 'install_declined',
    client: 'install_declined',
    afterStart: false,
    message: 'Запись отклонена, клиенту предложено выбрать другое время',
  },
  done: {
    from: ['requested', 'confirmed'],
    to: 'done',
    journal: 'install_done',
    client: null,
    afterStart: true,
    message: 'Установка отмечена выполненной',
  },
  no_show: {
    from: ['requested', 'confirmed'],
    to: 'no_show',
    journal: 'install_no_show',
    client: null,
    afterStart: true,
    message: 'Отмечено: клиент не приехал на установку',
  },
};

/** The staff decision on a booking: confirm / decline (the client is told), done / no_show. */
export async function decideInstall(
  deps: EngineDeps,
  input: { bookingId: string; decision: InstallDecision; note?: string | null; staff: StaffRef },
): Promise<ServiceResult> {
  const spec = DECISIONS[input.decision];
  if (!isUuid(input.bookingId) || spec === undefined) {
    return { ok: false, message: 'Запись не найдена', orderId: input.bookingId };
  }
  const note = input.note?.trim().slice(0, 500) || null;
  const actor: ActorRef = {
    type: 'staff',
    id: input.staff.id ?? (input.staff.via === 'admin' ? 'admin' : null),
    staffRole: input.staff.role,
  };
  const result = await deps.db.transaction(async (tx): Promise<ServiceResult> => {
    const found = await lockBooking(tx, input.bookingId);
    if (found === null)
      return { ok: false, message: 'Запись не найдена', orderId: input.bookingId };
    const { booking, order } = found;
    if (!spec.from.includes(booking.status)) {
      return { ok: false, message: 'Запись уже закрыта или подтверждена', orderId: order.id };
    }
    const now = clock(deps);
    if (spec.afterStart && now.getTime() < booking.slotAt.getTime()) {
      return { ok: false, message: 'Время записи ещё не наступило', orderId: order.id };
    }
    await tx
      .update(installBookings)
      .set({
        status: spec.to,
        ...(spec.to === 'confirmed' ? { confirmedAt: now } : {}),
        ...(spec.to === 'cancelled' ? { cancelledAt: now } : {}),
        ...(note !== null ? { staffNote: note } : {}),
        updatedAt: now,
      })
      .where(eq(installBookings.id, booking.id));
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId: order.id,
      type: spec.journal,
      actor,
      payload: {
        bookingId: booking.id,
        slotAt: booking.slotAt.toISOString(),
        via: input.staff.via,
      },
      at: now,
    });
    if (spec.client !== null) {
      await enqueueNotify(tx, {
        orderId: order.id,
        orderEventId,
        audience: 'client',
        template: spec.client,
      });
    }
    return { ok: true, message: spec.message, orderId: order.id };
  });
  if (result.ok) nudge(deps);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------------------------

/** Bookings of an order, oldest first (admin, /o/<token>, bot). No price. */
export async function loadBookingsView(
  db: Executor,
  orderId: string,
  options: { timeZone?: string } = {},
): Promise<BookingView[]> {
  if (!isUuid(orderId)) return [];
  const timeZone = options.timeZone ?? CLIENT_TIME_ZONE;
  const rows = await db
    .select()
    .from(installBookings)
    .where(eq(installBookings.orderId, orderId))
    .orderBy(asc(installBookings.createdAt), asc(installBookings.id));
  return rows.map((row) => ({
    id: row.id,
    orderId: row.orderId,
    slotAt: row.slotAt,
    status: row.status,
    createdVia: row.createdVia,
    confirmedAt: row.confirmedAt,
    cancelledAt: row.cancelledAt,
    staffNote: row.staffNote,
    createdAt: row.createdAt,
    slot: installSlotOf(slotPlan(row.slotAt), timeZone),
    active: HOLDING.includes(row.status),
    clientCancelUntil: new Date(
      row.slotAt.getTime() - INSTALL_CLIENT_CANCEL_BEFORE_MIN * MINUTE_MS,
    ),
  }));
}
