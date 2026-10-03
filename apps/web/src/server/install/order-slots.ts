/**
 * Installation slots of one order for /o/<token> (docs/phase-1c-implementation.md decision С6,
 * section 10.2). Live: installSlotsForOrder of @detaly/orders — the same planner and the same
 * load bookInstall checks again under its lock. Demo (/o/demo, no database): the same planner
 * over the simulated load, so the sample page shows believable chips without a single query.
 */
import type { Executor } from '@detaly/db';
import {
  CLIENT_TIME_ZONE,
  demoLoadSnapshot,
  installSlotOf,
  listInstallSlots,
  localDate,
  parseWorkHours,
  type InstallSlot,
  type IsoDate,
} from '@detaly/domain';
import { INSTALL_SLOTS_SHOWN } from '@detaly/domain/install-params';
import { installSlotsForOrder, type InstallSlotsReason } from '@detaly/orders';
import { INSTALL_LIFTS, INSTALL_TIME_ZONE, INSTALL_WINDOW_OPTIONS } from './config';

export interface OrderSlots {
  slots: InstallSlot[];
  /** Why the list is empty (null when there are slots). */
  reason: InstallSlotsReason | null;
}

/** Up to INSTALL_SLOTS_SHOWN free starts for the order (live bookings). */
export async function slotsForOrder(
  db: Executor,
  input: { orderId: string; now: Date; hours: string | null },
): Promise<OrderSlots> {
  const result = await installSlotsForOrder(db, {
    orderId: input.orderId,
    now: input.now,
    schedule: parseWorkHours(input.hours),
    limit: INSTALL_SLOTS_SHOWN,
    timeZone: CLIENT_TIME_ZONE,
  });
  return { slots: result.slots, reason: result.slots.length > 0 ? null : (result.reason ?? null) };
}

/**
 * Sample slots of the demo order: from its promised date over the simulated load. Never
 * touches the database; an unreadable PICKUP_HOURS gives no slots, as on a real page.
 */
export function demoSlotsForDate(input: {
  promisedDate: IsoDate | null;
  now: Date;
  hours: string | null;
}): OrderSlots {
  const schedule = parseWorkHours(input.hours);
  if (schedule === null) return { slots: [], reason: 'no_hours' };
  if (input.promisedDate === null) return { slots: [], reason: 'no_date' };
  const today = localDate(input.now, INSTALL_TIME_ZONE);
  const etaDate = input.promisedDate < today ? today : input.promisedDate;
  const plans = listInstallSlots({
    etaDate,
    now: input.now,
    timeZone: INSTALL_TIME_ZONE,
    schedule,
    load: demoLoadSnapshot({ schedule, capacity: INSTALL_LIFTS, timeZone: INSTALL_TIME_ZONE }),
    loadKind: 'demo',
    options: INSTALL_WINDOW_OPTIONS,
    limit: INSTALL_SLOTS_SHOWN,
  });
  const slots = plans.map((plan) => installSlotOf(plan, INSTALL_TIME_ZONE));
  return { slots, reason: slots.length > 0 ? null : 'full' };
}
