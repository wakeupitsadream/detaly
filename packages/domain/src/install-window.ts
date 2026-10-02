/**
 * "When will the car be ready" (docs/design.md, section 4): the part is at the pickup point on
 * a date -> the nearest free lift slot -> the car is ready at a time. Pure and deterministic:
 * the clock, the time zone, the working hours and the lift load are all passed in.
 */
import { addDays, CLIENT_TIME_ZONE, isIsoDate, weekdayShort } from './dates';
import type { InstallSlot, IsoDate } from './types';
import type { WeekSchedule } from './work-hours';

const MINUTE_MS = 60_000;

/** Lift load of one local hour starting at `hourStartMs`: `booked` of `capacity` lifts taken. */
export interface HourLoad {
  booked: number;
  capacity: number;
}

/** Load of the lifts by hour (start of a local hour, epoch ms). */
export type LoadSnapshot = (hourStartMs: number) => HourLoad;

/** Where the load came from: `demo` is simulated and the UI must say so. */
export type LoadKind = 'demo' | 'live';

export interface InstallWindowOptions {
  /** Supplier deliveries reach the point by this local time of the arrival day ('HH:MM'). */
  arrivalTime: string;
  /** Minimum minutes from now to a slot. */
  leadMin: number;
  /** A typical replacement job, minutes. */
  jobMin: number;
  /** Slot grid, minutes from local midnight. */
  stepMin: number;
  /** Days to look ahead, counted from the day the part is ready. */
  horizonDays: number;
}

export const DEFAULT_INSTALL_WINDOW_OPTIONS: InstallWindowOptions = {
  arrivalTime: '12:00',
  leadMin: 60,
  jobMin: 120,
  stepMin: 60,
  horizonDays: 14,
};

export interface InstallWindowInput {
  /** The day the part is at the pickup point (buffer already applied). */
  etaDate: IsoDate;
  now: Date;
  timeZone?: string;
  /** parseWorkHours(PICKUP_HOURS); null (not understood) gives no plan. */
  schedule: WeekSchedule | null;
  load: LoadSnapshot;
  loadKind?: LoadKind;
  options?: Partial<InstallWindowOptions>;
}

export interface InstallPlan {
  /** The part is at the point and the visit can start: max(now + lead, eta@arrival). */
  readyAt: Date;
  /** First slot of `jobMin` with a free lift in every hour it covers. */
  slotStart: Date;
  /** slotStart + jobMin. */
  carReadyAt: Date;
  loadKind: LoadKind;
}

/* ---- Zoned wall time --------------------------------------------------------------------- */

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Offset of `timeZone` from UTC at an instant, in minutes (Asia/Yekaterinburg: +300). */
export function zoneOffsetMin(instantMs: number, timeZone: string = CLIENT_TIME_ZONE): number {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - (instantMs - (instantMs % 1000))) / MINUTE_MS);
}

/** Local calendar date and minutes from local midnight of an instant. */
export function zonedWallTime(
  instantMs: number,
  timeZone: string = CLIENT_TIME_ZONE,
): { date: IsoDate; minutes: number } {
  const local = instantMs + zoneOffsetMin(instantMs, timeZone) * MINUTE_MS;
  const date = new Date(local).toISOString().slice(0, 10);
  const minutes = (local - Date.UTC(...ymd(date))) / MINUTE_MS;
  return { date, minutes };
}

function ymd(date: IsoDate): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return [y, m - 1, d];
}

/** The instant of a local wall time: `minutes` from local midnight of `date`. */
export function zonedInstant(
  date: IsoDate,
  minutes: number,
  timeZone: string = CLIENT_TIME_ZONE,
): number {
  const wallAsUtc = Date.UTC(...ymd(date)) + minutes * MINUTE_MS;
  // Two passes settle the offset across a DST change (Orenburg has none, the code does not care).
  let instant = wallAsUtc - zoneOffsetMin(wallAsUtc, timeZone) * MINUTE_MS;
  instant = wallAsUtc - zoneOffsetMin(instant, timeZone) * MINUTE_MS;
  return instant;
}

/** Day of week of a calendar date like Date#getUTCDay(): 0 = Sunday. */
export function isoWeekday(date: IsoDate): number {
  return new Date(Date.UTC(...ymd(date))).getUTCDay();
}

function parseClock(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  const minutes = m === null ? NaN : Number(m[1]) * 60 + Number(m[2]);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) {
    throw new RangeError(`invalid clock time '${value}'`);
  }
  return minutes;
}

function positiveInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be > 0`);
  return value;
}

/* ---- The plan ---------------------------------------------------------------------------- */

/** Every local hour that `[startMin, endMin)` of `date` touches is below capacity. */
function slotIsFree(
  date: IsoDate,
  startMin: number,
  endMin: number,
  load: LoadSnapshot,
  timeZone: string,
): boolean {
  for (let hour = Math.floor(startMin / 60); hour * 60 < endMin; hour += 1) {
    const { booked, capacity } = load(zonedInstant(date, hour * 60, timeZone));
    if (!(booked < capacity)) return false;
  }
  return true;
}

/**
 * The nearest install window, or null when there is none within the horizon or the working
 * hours were not understood (better to show nothing than to lie):
 *
 * 1. readyAt = max(now + leadMin, etaDate at arrivalTime);
 * 2. from the day of readyAt for horizonDays days, on working days, candidates every stepMin
 *    from max(open, readyAt rounded up to the step) while start + jobMin <= close;
 * 3. the first candidate whose every hour has booked < capacity.
 */
export function planInstallWindow(input: InstallWindowInput): InstallPlan | null {
  return listInstallSlots({ ...input, limit: 1 })[0] ?? null;
}

/**
 * Up to `limit` free install windows in time order, by the rules of planInstallWindow (its
 * result is the first element): the client chooses one of them to book (decision С6). Empty
 * when the working hours were not understood or nothing is free within the horizon.
 */
export function listInstallSlots(input: InstallWindowInput & { limit: number }): InstallPlan[] {
  const { etaDate, now, schedule, load } = input;
  const timeZone = input.timeZone ?? CLIENT_TIME_ZONE;
  const opts = { ...DEFAULT_INSTALL_WINDOW_OPTIONS, ...input.options };
  if (!isIsoDate(etaDate)) throw new RangeError(`invalid date '${String(etaDate)}'`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new RangeError('invalid now');
  const limit = positiveInt(input.limit, 'limit');
  const jobMin = positiveInt(opts.jobMin, 'jobMin');
  const stepMin = positiveInt(opts.stepMin, 'stepMin');
  const horizonDays = positiveInt(opts.horizonDays, 'horizonDays');
  if (!Number.isSafeInteger(opts.leadMin) || opts.leadMin < 0) {
    throw new RangeError('leadMin must be >= 0');
  }
  if (schedule === null || schedule.length !== 7) return [];

  const arrival = zonedInstant(etaDate, parseClock(opts.arrivalTime), timeZone);
  const readyAtMs = Math.max(now.getTime() + opts.leadMin * MINUTE_MS, arrival);
  const ready = zonedWallTime(readyAtMs, timeZone);
  const loadKind = input.loadKind ?? 'live';
  const slots: InstallPlan[] = [];

  for (let offset = 0; offset < horizonDays; offset += 1) {
    const date = addDays(ready.date, offset);
    const hours = schedule[isoWeekday(date)];
    if (hours === null || hours === undefined) continue;
    let start = hours.openMin;
    if (offset === 0) {
      const readyStep = Math.ceil(ready.minutes / stepMin) * stepMin;
      start = Math.max(start, readyStep);
    }
    for (let s = start; s + jobMin <= hours.closeMin; s += stepMin) {
      if (!slotIsFree(date, s, s + jobMin, load, timeZone)) continue;
      const slotStart = zonedInstant(date, s, timeZone);
      slots.push({
        readyAt: new Date(readyAtMs),
        slotStart: new Date(slotStart),
        carReadyAt: new Date(slotStart + jobMin * MINUTE_MS),
        loadKind,
      });
      if (slots.length >= limit) return slots;
    }
  }
  return slots;
}

const MONTHS_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
] as const;

/** ISO timestamp with the zone's offset: '2026-10-08T14:00:00+05:00'. */
export function zonedIso(instantMs: number, timeZone: string = CLIENT_TIME_ZONE): string {
  const offset = zoneOffsetMin(instantMs, timeZone);
  const local = new Date(instantMs - (instantMs % 1000) + offset * MINUTE_MS).toISOString();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local.slice(0, 19)}${sign}${hh}:${mm}`;
}

/** A plan as the client sees it: 'чт 8 окт' and '14:00' in the zone, ISO with the offset. */
export function installSlotOf(
  plan: Pick<InstallPlan, 'slotStart' | 'carReadyAt'>,
  timeZone: string = CLIENT_TIME_ZONE,
): InstallSlot {
  const start = zonedWallTime(plan.slotStart.getTime(), timeZone);
  const [, month, day] = start.date.split('-').map(Number) as [number, number, number];
  const hh = String(Math.floor(start.minutes / 60)).padStart(2, '0');
  const mm = String(Math.floor(start.minutes % 60)).padStart(2, '0');
  return {
    startAt: zonedIso(plan.slotStart.getTime(), timeZone),
    endAt: zonedIso(plan.carReadyAt.getTime(), timeZone),
    dayText: `${weekdayShort(start.date)} ${day} ${MONTHS_SHORT[month - 1] as string}`,
    timeText: `${hh}:${mm}`,
  };
}

/** One working hour of a day for the load strip under the plan. */
export interface HourCell {
  /** Local hour, 0..23. */
  hour: number;
  booked: number;
  capacity: number;
  /** The hour lies inside [slotStart, carReadyAt) of the plan. */
  inSlot: boolean;
}

/**
 * Working hours of the plan's slot day with their load, for the strip "busy / free / your
 * window". Empty when the day is not a working day of the schedule.
 */
export function dayLoadStrip(
  plan: Pick<InstallPlan, 'slotStart' | 'carReadyAt'>,
  schedule: WeekSchedule,
  load: LoadSnapshot,
  timeZone: string = CLIENT_TIME_ZONE,
): HourCell[] {
  const slot = zonedWallTime(plan.slotStart.getTime(), timeZone);
  const hours = schedule[isoWeekday(slot.date)];
  if (hours === null || hours === undefined) return [];
  const slotEnd = slot.minutes + (plan.carReadyAt.getTime() - plan.slotStart.getTime()) / MINUTE_MS;
  const cells: HourCell[] = [];
  for (let hour = Math.floor(hours.openMin / 60); hour * 60 < hours.closeMin; hour += 1) {
    const { booked, capacity } = load(zonedInstant(slot.date, hour * 60, timeZone));
    cells.push({
      hour,
      booked,
      capacity,
      inSlot: hour * 60 < slotEnd && (hour + 1) * 60 > slot.minutes,
    });
  }
  return cells;
}
