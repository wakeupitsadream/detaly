/**
 * Step 8 (docs/rossko-automation.md, audit roadmap r11): Rossko without the manual cabinet. Pure
 * functions only — the clock, the working hours of the pickup point (PICKUP_HOURS, the same
 * parseWorkHours schedule everyone uses) and the zone are passed in:
 *
 * - the settings of the step (the GetOrders status map, the polling switch, the order deadline,
 *   the shadow auto-order limit, the Rossko cutoff times) with their parsers;
 * - the deadline alerts to the sellers chat: «Не заказано у поставщика», «Срок поставщика под
 *   угрозой», «Срок сорван», «Не забирают» — which one is due, when, the idempotent key and the
 *   text;
 * - the cutoff reminder 25 minutes before a Rossko order deadline on working days;
 * - the shadow auto-order: shouldAutoOrder() decides what an automatic order WOULD do at
 *   «Проверить и заказать» (the real auto-order stays off, PLAN decision 7), the agreement
 *   statistics with the master and the plain-language verdict.
 *
 * The Rossko GetOrders status codes and their meanings are unknown (docs/external.md R11):
 * nothing here acts on a code; the map from a code to an action is data the founder fills in.
 */
import { addDays, CLIENT_TIME_ZONE, formatPromise, localDate } from './dates';
import { workingMinutesBetween } from './fit-checks';
import { isoWeekday, zonedInstant } from './install-window';
import { formatRub, marginBp } from './money';
import type { RecheckResult } from './recheck-types';
import type { OrderNotifyTemplate } from './state-machine';
import type { OrderStatus, PaymentScheme } from './statuses';
import type { IsoDate, Kop, RosskoStatusActionSetting } from './types';
import type { WeekSchedule } from './work-hours';

const MINUTE_MS = 60_000;
/** Days scanned back or forward for a working day (a schedule has one every week). */
const MAX_SCAN_DAYS = 14;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** settings `rossko.order_status_map`: GetOrders status code -> what to do. */
export const ROSSKO_STATUS_MAP_KEY = 'rossko.order_status_map';
/** settings `rossko.poll_enabled`: the GetOrders polling (only with ROSSKO_MODE=live). */
export const ROSSKO_POLL_ENABLED_KEY = 'rossko.poll_enabled';
/** settings `rossko.order_within_minutes`: «Не заказано у поставщика» after this. */
export const ROSSKO_ORDER_WITHIN_KEY = 'rossko.order_within_minutes';
/** settings `rossko.auto_order_max_total_kop`: the shadow auto-order limit of the order total. */
export const AUTO_ORDER_MAX_TOTAL_KEY = 'rossko.auto_order_max_total_kop';
/** settings `rossko.cutoff_times`: the Rossko manager's order deadlines, ['11:00', '16:00']. */
export const ROSSKO_CUTOFF_TIMES_KEY = 'rossko.cutoff_times';

/** Two hours of working time (the audit: «confirmed больше 2 рабочих часов без заказа»). */
export const DEFAULT_ROSSKO_ORDER_WITHIN_MINUTES = 120;
export const ROSSKO_ORDER_WITHIN_MIN_MINUTES = 15;
export const ROSSKO_ORDER_WITHIN_MAX_MINUTES = 24 * 60;
/** 15 000 ₽, the same bound as the payment on handover (ON_PICKUP_MAX_TOTAL). */
export const DEFAULT_AUTO_ORDER_MAX_TOTAL_KOP: Kop = 1_500_000;
/** The largest limit the admin may set: the largest order (MAX_ORDER_TOTAL_KOP, 500 000 ₽). */
export const AUTO_ORDER_MAX_TOTAL_LIMIT_KOP: Kop = 50_000_000;
/** Cutoff times the admin may list. */
export const ROSSKO_CUTOFF_TIMES_MAX = 6;
/** Codes the status map may hold (Rossko names 16; room for renumbering). */
export const ROSSKO_STATUS_MAP_MAX = 64;
/** The cutoff reminder goes this many minutes before the cutoff. */
export const ROSSKO_CUTOFF_LEAD_MINUTES = 25;

/**
 * What a GetOrders status code means for us:
 * - shipped_to_point: Rossko shipped the order to the pickup point — the sellers get the order
 *   card «проверьте приёмку» with the «Приехало» buttons (the arrival stays a human button);
 * - refused: the supplier refused — the order goes the way of «Проблема с позицией» → «Отказ
 *   поставщика» (needs_attention), once per item;
 * - in_progress / ignore: nothing.
 * A code that is not in the map (unmapped) is never acted on: one staff alert asks what it means.
 */
export const ROSSKO_STATUS_ACTIONS = [
  'shipped_to_point',
  'refused',
  'in_progress',
  'ignore',
] as const satisfies readonly RosskoStatusActionSetting[];
export type RosskoStatusAction = (typeof ROSSKO_STATUS_ACTIONS)[number];

export const ROSSKO_STATUS_ACTION_LABELS: Readonly<Record<RosskoStatusAction, string>> = {
  shipped_to_point: 'Отгружен на точку — карточка «проверьте приёмку»',
  refused: 'Отказ поставщика — «Требует внимания»',
  in_progress: 'В работе — ничего не делать',
  ignore: 'Не важно — ничего не делать',
};

/** settings `rossko.order_status_map`: {"<code>": action}; {} by default (nothing is mapped). */
export type RosskoStatusMap = Readonly<Record<string, RosskoStatusAction>>;

export function isRosskoStatusAction(value: unknown): value is RosskoStatusAction {
  return typeof value === 'string' && (ROSSKO_STATUS_ACTIONS as readonly string[]).includes(value);
}

/** A status code as a map key: a non-negative integer of at most 6 digits, without leading 0s. */
export function isRosskoStatusCodeKey(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,5})$/.test(value);
}

/** The map key of a code; null for a code that cannot be a key (negative, fractional, huge). */
export function rosskoStatusCodeKey(code: number | null | undefined): string | null {
  if (typeof code !== 'number' || !Number.isSafeInteger(code) || code < 0) return null;
  const key = String(code);
  return isRosskoStatusCodeKey(key) ? key : null;
}

/** A valid map in its normal form (keys sorted by number), or null for anything else. */
export function parseRosskoStatusMap(value: unknown): RosskoStatusMap | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > ROSSKO_STATUS_MAP_MAX) return null;
  for (const [code, action] of entries) {
    if (!isRosskoStatusCodeKey(code) || !isRosskoStatusAction(action)) return null;
  }
  entries.sort(([a], [b]) => Number(a) - Number(b));
  return Object.fromEntries(entries) as RosskoStatusMap;
}

/** Equal maps (the audited writer stores nothing for an unchanged value). */
export function sameRosskoStatusMap(a: RosskoStatusMap, b: RosskoStatusMap): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((key) => a[key] === b[key]);
}

/** The action of a code, or null when the code is not mapped (or there is no code). */
export function rosskoStatusAction(
  map: RosskoStatusMap,
  code: number | null | undefined,
): RosskoStatusAction | null {
  const key = rosskoStatusCodeKey(code);
  if (key === null || !Object.hasOwn(map, key)) return null;
  return map[key] ?? null;
}

export function isRosskoOrderWithinMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= ROSSKO_ORDER_WITHIN_MIN_MINUTES &&
    value <= ROSSKO_ORDER_WITHIN_MAX_MINUTES
  );
}

export function isAutoOrderMaxTotalKop(value: unknown): value is Kop {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= AUTO_ORDER_MAX_TOTAL_LIMIT_KOP
  );
}

const CLOCK_RE = /^(\d{1,2})[:.](\d{2})$/;

/** '9:30' / '09.30' -> '09:30'; null for anything that is not a time of day. */
export function normalizeCutoffTime(text: string): string | null {
  const match = CLOCK_RE.exec(text.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Sorted, without repeats, at most ROSSKO_CUTOFF_TIMES_MAX; null when something is wrong. */
function normalizeCutoffList(times: readonly string[]): string[] | null {
  const normal: string[] = [];
  for (const time of times) {
    const value = normalizeCutoffTime(time);
    if (value === null) return null;
    if (!normal.includes(value)) normal.push(value);
  }
  if (normal.length > ROSSKO_CUTOFF_TIMES_MAX) return null;
  return normal.sort();
}

/** settings `rossko.cutoff_times` (a stored array) in its normal form, or null. */
export function parseCutoffTimes(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((time) => typeof time === 'string')) return null;
  return normalizeCutoffList(value as string[]);
}

/** The admin's input «11:00, 16:00» (commas, spaces, semicolons or lines); '' is []. */
export function parseCutoffText(text: string): string[] | null {
  const parts = text
    .split(/[\s,;]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return normalizeCutoffList(parts);
}

/** The settings of step 8 with their defaults (loadRosskoSettings of @detaly/orders reads them). */
export interface RosskoAutomationSettings {
  statusMap: RosskoStatusMap;
  pollEnabled: boolean;
  orderWithinMinutes: number;
  autoOrderMaxTotalKop: Kop;
  cutoffTimes: string[];
}

export const DEFAULT_ROSSKO_AUTOMATION_SETTINGS: Readonly<RosskoAutomationSettings> = {
  statusMap: {},
  pollEnabled: false,
  orderWithinMinutes: DEFAULT_ROSSKO_ORDER_WITHIN_MINUTES,
  autoOrderMaxTotalKop: DEFAULT_AUTO_ORDER_MAX_TOTAL_KOP,
  cutoffTimes: [],
};

/** Raw rows (key -> jsonb) over the defaults; a malformed value falls back to its default. */
export function resolveRosskoAutomationSettings(
  rows: ReadonlyMap<string, unknown>,
): RosskoAutomationSettings {
  const defaults = DEFAULT_ROSSKO_AUTOMATION_SETTINGS;
  const poll = rows.get(ROSSKO_POLL_ENABLED_KEY);
  const within = rows.get(ROSSKO_ORDER_WITHIN_KEY);
  const total = rows.get(AUTO_ORDER_MAX_TOTAL_KEY);
  return {
    statusMap: parseRosskoStatusMap(rows.get(ROSSKO_STATUS_MAP_KEY)) ?? defaults.statusMap,
    pollEnabled: typeof poll === 'boolean' ? poll : defaults.pollEnabled,
    orderWithinMinutes: isRosskoOrderWithinMinutes(within) ? within : defaults.orderWithinMinutes,
    autoOrderMaxTotalKop: isAutoOrderMaxTotalKop(total) ? total : defaults.autoOrderMaxTotalKop,
    cutoffTimes: parseCutoffTimes(rows.get(ROSSKO_CUTOFF_TIMES_KEY)) ?? [...defaults.cutoffTimes],
  };
}

// ---------------------------------------------------------------------------
// Working days of the pickup point
// ---------------------------------------------------------------------------

function hasWeek(schedule: WeekSchedule | null | undefined): schedule is WeekSchedule {
  return schedule !== null && schedule !== undefined && schedule.length === 7;
}

/** The day is a working day of the point; without a schedule every day is. */
export function isWorkingDay(date: IsoDate, schedule: WeekSchedule | null | undefined): boolean {
  return !hasWeek(schedule) || schedule[isoWeekday(date)] != null;
}

/** The opening and the closing of a working day; null for a day off or without a schedule. */
export function workingDayBounds(
  date: IsoDate,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): { open: Date; close: Date } | null {
  if (!hasWeek(schedule)) return null;
  const hours = schedule[isoWeekday(date)];
  if (!hours) return null;
  return {
    open: new Date(zonedInstant(date, hours.openMin, timeZone)),
    close: new Date(zonedInstant(date, hours.closeMin, timeZone)),
  };
}

/**
 * The `days`-th working day after `date` (`date` itself does not count). Without a schedule:
 * `date + days`.
 */
export function addWorkingDays(
  date: IsoDate,
  days: number,
  schedule: WeekSchedule | null | undefined,
): IsoDate {
  if (!Number.isSafeInteger(days) || days < 0) throw new RangeError('days must be >= 0');
  if (!hasWeek(schedule)) return addDays(date, days);
  let current = date;
  let left = days;
  for (let i = 0; left > 0 && i <= days * 7 + MAX_SCAN_DAYS; i += 1) {
    current = addDays(current, 1);
    if (isWorkingDay(current, schedule)) left -= 1;
  }
  return current;
}

/**
 * The end of the last working day before `date`: its closing time. Without a schedule (or with
 * no working day found) the end of the previous calendar day, i.e. local midnight of `date`.
 */
export function previousWorkingDayClose(
  date: IsoDate,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): Date {
  if (hasWeek(schedule)) {
    for (let back = 1; back <= MAX_SCAN_DAYS; back += 1) {
      const bounds = workingDayBounds(addDays(date, -back), schedule, timeZone);
      if (bounds !== null) return bounds.close;
    }
  }
  return new Date(zonedInstant(date, 0, timeZone));
}

/**
 * The start of the first working day after `date`: its opening time. Without a schedule (or with
 * no working day found) local midnight of the next calendar day.
 */
export function nextWorkingDayOpen(
  date: IsoDate,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): Date {
  if (hasWeek(schedule)) {
    for (let ahead = 1; ahead <= MAX_SCAN_DAYS; ahead += 1) {
      const bounds = workingDayBounds(addDays(date, ahead), schedule, timeZone);
      if (bounds !== null) return bounds.open;
    }
  }
  return new Date(zonedInstant(addDays(date, 1), 0, timeZone));
}

// ---------------------------------------------------------------------------
// Deadline alerts (housekeeping every 10 minutes, one per order and kind)
// ---------------------------------------------------------------------------

/**
 * - not_ordered: `confirmed` (or stuck in `ordering`) longer than `rossko.order_within_minutes`
 *   of working time without a supplier order;
 * - supplier_late: ordered at the supplier and a live item is still not at the point at the end
 *   of the working day before the promised date;
 * - supplier_overdue: the same from the first working day after the promised date;
 * - not_picked_up: ready for more than NOT_PICKED_UP_WORKING_DAYS working days.
 */
export const DEADLINE_ALERT_KINDS = [
  'not_ordered',
  'supplier_late',
  'supplier_overdue',
  'not_picked_up',
] as const;
export type DeadlineAlertKind = (typeof DEADLINE_ALERT_KINDS)[number];

/** «Не забирают»: the order waits at the point longer than this many working days. */
export const NOT_PICKED_UP_WORKING_DAYS = 3;

/** Statuses of the order that «Не заказано у поставщика» watches. */
export const NOT_ORDERED_STATUSES = [
  'confirmed',
  'ordering',
] as const satisfies readonly OrderStatus[];

/** The first line of the sellers card of each alert (headline before the order number). */
export const DEADLINE_ALERT_HEADLINES: Readonly<Record<DeadlineAlertKind, string>> = {
  not_ordered: 'Не заказано у поставщика',
  supplier_late: 'Срок поставщика под угрозой',
  supplier_overdue: 'Срок сорван',
  not_picked_up: 'Не забирают',
};

/** The sellers card template of each alert (posted through notify/order, as reminders are). */
export const DEADLINE_ALERT_TEMPLATES: Readonly<Record<DeadlineAlertKind, OrderNotifyTemplate>> = {
  not_ordered: 'staff_not_ordered',
  supplier_late: 'staff_supplier_late',
  supplier_overdue: 'staff_supplier_overdue',
  not_picked_up: 'staff_not_picked_up',
};

/** What the decision needs of an order (no PD). */
export interface DeadlineAlertOrder {
  status: OrderStatus;
  /** When the order entered its current status (the journal; updated_at without one). */
  statusSince: Date;
  /** A supplier order of the order is `created`: Rossko took it. */
  hasSupplierOrder: boolean;
  /** orders.promised_date: the date the client was promised. */
  promisedDate: IsoDate | null;
  /** Live items not at the point yet (`pending`, `ordered`). */
  itemsNotArrived: number;
  /** orders.received_at: when the order became ready. */
  receivedAt: Date | null;
}

export interface DeadlineAlertContext {
  now: Date;
  /** parseWorkHours(PICKUP_HOURS); without it every minute and every day counts. */
  schedule: WeekSchedule | null | undefined;
  timeZone?: string;
  /** settings `rossko.order_within_minutes`. */
  orderWithinMinutes: number;
}

/** «Срок поставщика под угрозой» is due at the end of the working day before the promise. */
export function supplierLateAt(
  promised: IsoDate,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): Date {
  return previousWorkingDayClose(promised, schedule, timeZone);
}

/** «Срок сорван» is due at the opening of the first working day after the promised date. */
export function supplierOverdueAt(
  promised: IsoDate,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): Date {
  return nextWorkingDayOpen(promised, schedule, timeZone);
}

/**
 * «Не забирают» is due at the opening of the working day after the NOT_PICKED_UP_WORKING_DAYS-th
 * working day after the arrival day: arrived Monday 15:00 (Mon–Fri) — Friday at the opening.
 */
export function notPickedUpAt(
  receivedAt: Date,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): Date {
  const arrival = localDate(receivedAt, timeZone);
  const lastDay = addWorkingDays(arrival, NOT_PICKED_UP_WORKING_DAYS, schedule);
  return nextWorkingDayOpen(lastDay, schedule, timeZone);
}

/**
 * The alert due for the order now, or null. The statuses do not overlap, so at most one kind is
 * due; after a gap «Срок сорван» wins over «под угрозой» (the latest one only).
 */
export function deadlineAlertDue(
  order: DeadlineAlertOrder,
  ctx: DeadlineAlertContext,
): DeadlineAlertKind | null {
  const timeZone = ctx.timeZone ?? CLIENT_TIME_ZONE;
  const now = ctx.now.getTime();
  switch (order.status) {
    case 'confirmed':
    case 'ordering': {
      if (order.hasSupplierOrder) return null;
      const minutes = workingMinutesBetween(order.statusSince, ctx.now, ctx.schedule, timeZone);
      return minutes > ctx.orderWithinMinutes ? 'not_ordered' : null;
    }
    case 'ordered_at_supplier': {
      if (order.itemsNotArrived <= 0 || order.promisedDate === null) return null;
      if (now >= supplierOverdueAt(order.promisedDate, ctx.schedule, timeZone).getTime()) {
        return 'supplier_overdue';
      }
      if (now >= supplierLateAt(order.promisedDate, ctx.schedule, timeZone).getTime()) {
        return 'supplier_late';
      }
      return null;
    }
    case 'ready': {
      if (order.receivedAt === null) return null;
      return now >= notPickedUpAt(order.receivedAt, ctx.schedule, timeZone).getTime()
        ? 'not_picked_up'
        : null;
    }
    // Every other status has no deadline alert.
    case 'draft':
    case 'awaiting_payment':
    case 'awaiting_confirmation':
    case 'awaiting_supplier_invoice':
    case 'needs_attention':
    case 'awaiting_client_approval':
    case 'awaiting_handover_payment':
    case 'out_for_delivery':
    case 'handed':
    case 'completed':
    case 'cancelled':
    case 'refund_pending':
    case 'refunded':
      return null;
  }
}

/** The reminder kind of an alert in the outbox key (`reminder:<order>:<kind>:<n>`, Б27). */
export function deadlineReminderKind(kind: DeadlineAlertKind): string {
  return `rossko_${kind}`;
}

/** One alert per order and kind: the outbox key never changes, so it is queued once. */
export function deadlineAlertKey(orderId: string, kind: DeadlineAlertKind): string {
  return `reminder:${orderId}:${deadlineReminderKind(kind)}:1`;
}

/** «2 ч», «1 ч 30 мин», «45 мин». */
export function workingTimeText(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/**
 * The line of the card under the alert (no PD). «Срок сорван» of a prepaid order reminds of the
 * penalty risk in one neutral line (art. 23.1 of the consumer protection law applies to prepaid
 * goods only).
 */
export function deadlineAlertNote(
  kind: DeadlineAlertKind,
  input: {
    status: OrderStatus;
    scheme: PaymentScheme;
    promisedDate: IsoDate | null;
    orderWithinMinutes: number;
  },
): string {
  const promise = input.promisedDate ? formatPromise(input.promisedDate) : null;
  switch (kind) {
    case 'not_ordered':
      return input.status === 'ordering'
        ? `Заказ у Rossko не завершился больше ${workingTimeText(input.orderWithinMinutes)} рабочего времени — проверьте ЛК Rossko и карточку заказа в админке.`
        : `Не заказано у поставщика больше ${workingTimeText(input.orderWithinMinutes)} рабочего времени — нажмите «Проверить и заказать».`;
    case 'supplier_late':
      return `Клиенту обещано ${promise ?? 'к сроку'}, а детали ещё не приехали — позвоните менеджеру Rossko и уточните срок.`;
    case 'supplier_overdue': {
      const line = `Обещали клиенту ${promise ?? 'к сроку'}, детали не приехали — позвоните менеджеру Rossko и клиенту.`;
      return input.scheme === 'prepay'
        ? `${line}\nПросрочка выдачи предоплаченного заказа — риск неустойки 0,5% в день (ст. 23.1 ЗоЗПП).`
        : line;
    }
    case 'not_picked_up':
      return `Заказ ждёт клиента больше ${NOT_PICKED_UP_WORKING_DAYS} рабочих дней — позвоните клиенту.`;
  }
}

// ---------------------------------------------------------------------------
// GetOrders polling: the texts of the actions (no PD: order numbers, Rossko numbers, parts)
// ---------------------------------------------------------------------------

/** A Rossko status name as stored and shown: one line, at most 200 characters; null if empty. */
export function cleanRosskoStatusName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const line = name.replace(/\s+/gu, ' ').trim();
  if (line === '') return null;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function statusPhrase(code: number, name: string | null): string {
  return name === null ? `без названия (код ${code})` : `«${name}» (код ${code})`;
}

/** The note of the sellers card «Отгружено Rossko» (status mapped to shipped_to_point). */
export function supplierShippedNote(input: {
  orderNumber: string;
  rosskoOrderId: string;
  statusName: string | null;
}): string {
  const status = input.statusName === null ? '' : `: «${input.statusName}»`;
  return `Rossko отгрузил заказ ${input.orderNumber} на точку — проверьте приёмку (Rossko № ${input.rosskoOrderId}${status}).`;
}

/** One staff alert per supplier order and code: a code that is not in the map. */
export function unmappedStatusText(input: {
  code: number;
  name: string | null;
  orderNumber: string;
  rosskoOrderId: string;
  /** APP_BASE_URL/admin/rossko */
  adminUrl: string;
}): string {
  return (
    `Rossko: статус ${statusPhrase(input.code, input.name)} — что это значит? Настройте в /admin/rossko.\n` +
    `Заказ ${input.orderNumber}, Rossko № ${input.rosskoOrderId}. ${input.adminUrl}`
  );
}

/**
 * A refusal (status mapped to `refused`) the order engine could not take: the order is not
 * waiting for the supplier any more, or the refused parts are not known. The staff checks by hand.
 */
export function supplierRefusedText(input: {
  code: number;
  name: string | null;
  orderNumber: string;
  rosskoOrderId: string;
  /** «Knecht OC 90, TRW GDB1330»; empty when GetOrders did not say which parts. */
  parts: string;
  /** ORDER_STATUS_LABELS of the order. */
  statusLabel: string;
  /** APP_BASE_URL/admin/orders/<id> */
  adminUrl: string;
}): string {
  const parts = input.parts === '' ? 'какие позиции — не указано' : input.parts;
  return (
    `Rossko: отказ поставщика по заказу ${input.orderNumber} (Rossko № ${input.rosskoOrderId}, ` +
    `статус ${statusPhrase(input.code, input.name)}): ${parts}. Заказ сейчас «${input.statusLabel}» — ` +
    `проверьте позиции. ${input.adminUrl}`
  );
}

// ---------------------------------------------------------------------------
// The cutoff reminder (25 minutes before a Rossko order deadline, working days)
// ---------------------------------------------------------------------------

export interface CutoffReminder {
  /** 'HH:MM' of the cutoff. */
  cutoff: string;
  /** The local date of the cutoff. */
  date: IsoDate;
  /** The cutoff instant. */
  at: Date;
  /** Whole minutes left until the cutoff (rounded up): 25 at the lead time. */
  minutesLeft: number;
  /** One push per cutoff and day: `rossko-cutoff:<date>:<HH:MM>`. */
  key: string;
}

function clockMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return hours * 60 + minutes;
}

/**
 * The cutoff whose reminder is due now: `now` is within `leadMinutes` before it (the first such
 * cutoff of the day), on a working day of the pickup point. A run that was late still reminds
 * until the cutoff itself, with the minutes that are actually left. null: nothing is due (no
 * cutoff times, a day off, outside every window).
 */
export function cutoffReminderDue(input: {
  now: Date;
  cutoffTimes: readonly string[];
  schedule: WeekSchedule | null | undefined;
  timeZone?: string;
  leadMinutes?: number;
}): CutoffReminder | null {
  const timeZone = input.timeZone ?? CLIENT_TIME_ZONE;
  const lead = input.leadMinutes ?? ROSSKO_CUTOFF_LEAD_MINUTES;
  const today = localDate(input.now, timeZone);
  if (!isWorkingDay(today, input.schedule)) return null;
  const now = input.now.getTime();
  for (const time of [...input.cutoffTimes].sort()) {
    const normal = normalizeCutoffTime(time);
    if (normal === null) continue;
    const at = zonedInstant(today, clockMinutes(normal), timeZone);
    if (now >= at - lead * MINUTE_MS && now < at) {
      return {
        cutoff: normal,
        date: today,
        at: new Date(at),
        minutesLeft: Math.ceil((at - now) / MINUTE_MS),
        key: cutoffReminderKey(today, normal),
      };
    }
  }
  return null;
}

export function cutoffReminderKey(date: IsoDate, cutoff: string): string {
  return `rossko-cutoff:${date}:${cutoff}`;
}

/** Russian plural: 1 заказ, 2 заказа, 5 заказов. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** «Через 25 минут отсечка Rossko (11:00): не заказано 2 заказа.» */
export function cutoffReminderText(input: {
  minutesLeft: number;
  cutoff: string;
  notOrdered: number;
}): string {
  const minutes = `${input.minutesLeft} ${plural(input.minutesLeft, 'минуту', 'минуты', 'минут')}`;
  const verb = plural(input.notOrdered, 'не заказан', 'не заказано', 'не заказано');
  const orders = `${input.notOrdered} ${plural(input.notOrdered, 'заказ', 'заказа', 'заказов')}`;
  return `Через ${minutes} отсечка Rossko (${input.cutoff}): ${verb} ${orders}.`;
}

// ---------------------------------------------------------------------------
// The shadow auto-order (PLAN decision 7: the real auto-order stays off)
// ---------------------------------------------------------------------------

/**
 * Why an automatic order would NOT have been placed, in the order of the card line:
 * - not_rechecked: a live item was not rechecked at the supplier;
 * - unavailable: an item is gone, short of stock or now in an excluded group;
 * - price_drift: an item's supplier price grew more than the tolerance (PRICE_DRIFT_TOLERANCE);
 * - vin_selection: the line comes from a VIN selection and the master did not confirm this very
 *   part with «Подходит» (PLAN phase 4: the auto-order is for lines without a VIN selection);
 * - fit_unconfirmed: the client asked «подойдёт ли?» about the line and the master did not confirm
 *   it (no answer, «Не подходит», «Нужен звонок», his analog offered but the part kept);
 * - total_over_limit: the order total is above `rossko.auto_order_max_total_kop`;
 * - no_show: the client did not come for an order before (users.no_show_count > 0);
 * - margin_floor: the margin at the fresh supplier prices is below the floor.
 */
export const AUTO_ORDER_REASONS = [
  'not_rechecked',
  'unavailable',
  'price_drift',
  'vin_selection',
  'fit_unconfirmed',
  'total_over_limit',
  'no_show',
  'margin_floor',
] as const;
export type AutoOrderReason = (typeof AUTO_ORDER_REASONS)[number];

export const AUTO_ORDER_REASON_LABELS: Readonly<Record<AutoOrderReason, string>> = {
  not_rechecked: 'не все позиции перепроверены у поставщика',
  unavailable: 'у поставщика нет нужного количества',
  price_drift: 'цена у поставщика выросла больше допуска',
  vin_selection: 'подбор по VIN — нужен мастер',
  fit_unconfirmed: 'мастер не подтвердил деталь после проверки подбора',
  total_over_limit: 'сумма больше порога автозаказа',
  no_show: 'клиент уже не приходил за заказом',
  margin_floor: 'маржа ниже порога',
};

export function isAutoOrderReason(value: unknown): value is AutoOrderReason {
  return typeof value === 'string' && (AUTO_ORDER_REASONS as readonly string[]).includes(value);
}

/** A live line of the order as the shadow sees it. */
export interface AutoOrderLine {
  orderItemId: string;
  qty: number;
  /** order_items.price_client_kop (per unit). */
  priceClientKop: Kop;
  /** The order was checked out from a VIN proposal and the line is one of its parts. */
  fromVinSelection: boolean;
  /**
   * The fit check of the line: `confirmed` — «Проверено мастером» (he said «Подходит» about this
   * very part, or it is the analog he offered and the client took); `unconfirmed` — the client
   * asked and the master did not confirm the part; null — nobody asked.
   */
  fitCheck: 'confirmed' | 'unconfirmed' | null;
}

export interface AutoOrderInput {
  /** The live items of the order. */
  lines: readonly AutoOrderLine[];
  /** The recheck the master's «Проверить и заказать» just ran. */
  recheck: Pick<RecheckResult, 'items'>;
  /** orders.total_kop. */
  totalKop: Kop;
  /** settings `rossko.auto_order_max_total_kop`. */
  maxTotalKop: Kop;
  /** users.no_show_count of the client. */
  noShowCount: number;
  /** settings pricing.drift_tolerance_pct in bp. */
  driftToleranceBp: number;
  /** settings pricing.margin_floor_pct in bp. */
  marginFloorBp: number;
}

export interface AutoOrderDecision {
  decision: 'yes' | 'no';
  reasons: AutoOrderReason[];
  /** Margin at the fresh supplier prices (bp of the client total); null when not computable. */
  marginBp: number | null;
}

/**
 * Would an automatic order have been placed? Every condition must hold for `yes`: every live
 * item rechecked, in stock with enough quantity and within the price tolerance; no line of a VIN
 * selection or a fit check the master has not confirmed; the total within the limit; the client
 * without no-shows; the margin at the fresh prices at least the floor.
 */
export function shouldAutoOrder(input: AutoOrderInput): AutoOrderDecision {
  const reasons = new Set<AutoOrderReason>();
  const rechecked = new Map(input.recheck.items.map((item) => [item.orderItemId, item]));
  let client = 0;
  let supplier = 0;
  let pricesKnown = input.lines.length > 0;
  if (input.lines.length === 0) reasons.add('not_rechecked');
  for (const line of input.lines) {
    const result = rechecked.get(line.orderItemId);
    if (result === undefined) {
      reasons.add('not_rechecked');
      pricesKnown = false;
    } else {
      if (result.status !== 'ok') reasons.add('unavailable');
      // An item without a fresh price (driftBp null) is `unavailable` already.
      if (result.driftBp !== null && result.driftBp > input.driftToleranceBp) {
        reasons.add('price_drift');
      }
      if (result.freshPriceSupplierKop === null) pricesKnown = false;
      else supplier += result.freshPriceSupplierKop * line.qty;
    }
    client += line.priceClientKop * line.qty;
    if (line.fitCheck === 'unconfirmed') reasons.add('fit_unconfirmed');
    else if (line.fromVinSelection && line.fitCheck !== 'confirmed') reasons.add('vin_selection');
  }
  if (input.totalKop > input.maxTotalKop) reasons.add('total_over_limit');
  if (input.noShowCount > 0) reasons.add('no_show');
  let margin: number | null = null;
  if (pricesKnown && client > 0) {
    margin = marginBp(client, supplier);
    if (margin < input.marginFloorBp) reasons.add('margin_floor');
  }
  const ordered = AUTO_ORDER_REASONS.filter((reason) => reasons.has(reason));
  return { decision: ordered.length === 0 ? 'yes' : 'no', reasons: ordered, marginBp: margin };
}

/** The text of a reason; the total names the limit («сумма больше 15 000 ₽»). */
export function autoOrderReasonText(
  reason: AutoOrderReason,
  input: { maxTotalKop?: Kop | null } = {},
): string {
  if (reason === 'total_over_limit' && typeof input.maxTotalKop === 'number') {
    return `сумма больше ${formatRub(input.maxTotalKop)}`;
  }
  return AUTO_ORDER_REASON_LABELS[reason];
}

/** The one line of the seller card: «Автозаказ бы: ДА» / «Автозаказ бы: НЕТ — <причины>». */
export function autoOrderLine(
  decision: Pick<AutoOrderDecision, 'decision' | 'reasons'>,
  input: { maxTotalKop?: Kop | null } = {},
): string {
  if (decision.decision === 'yes') return 'Автозаказ бы: ДА';
  const reasons = decision.reasons.map((reason) => autoOrderReasonText(reason, input));
  return reasons.length === 0 ? 'Автозаказ бы: НЕТ' : `Автозаказ бы: НЕТ — ${reasons.join(', ')}`;
}

/** The journal payload of order_events `auto_order_shadow` (written by the rossko/recheck job). */
export interface AutoOrderShadowPayload {
  decision: 'yes' | 'no';
  reasons: AutoOrderReason[];
  /** The press sent the order to the supplier (the recheck passed: `ordering`). */
  masterOrdered: boolean;
  /** The limit the decision was made with (the card names it). */
  maxTotalKop: Kop | null;
}

/** A stored payload read back; null for anything that is not one. */
export function parseAutoOrderShadow(payload: unknown): AutoOrderShadowPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  if (value.decision !== 'yes' && value.decision !== 'no') return null;
  if (!Array.isArray(value.reasons) || !value.reasons.every(isAutoOrderReason)) return null;
  const maxTotal = value.maxTotalKop;
  return {
    decision: value.decision,
    reasons: [...(value.reasons as AutoOrderReason[])],
    masterOrdered: value.masterOrdered === true,
    maxTotalKop: isAutoOrderMaxTotalKop(maxTotal) ? maxTotal : null,
  };
}

/**
 * Order statuses whose seller card shows the shadow line of the latest «Проверить и заказать»:
 * from the press until the parts arrive.
 */
export const AUTO_ORDER_LINE_STATUSES = [
  'ordering',
  'awaiting_supplier_invoice',
  'ordered_at_supplier',
  'needs_attention',
  'awaiting_client_approval',
] as const satisfies readonly OrderStatus[];

// ---------------------------------------------------------------------------
// The shadow statistics and the verdict (/admin/auto-order)
// ---------------------------------------------------------------------------

/** The verdict needs at least this many shadow decisions. */
export const AUTO_ORDER_VERDICT_MIN_DECISIONS = 30;
/** …and the master doing the same as the shadow in at least 95 % of them. */
export const AUTO_ORDER_VERDICT_MIN_AGREEMENT_PCT = 95;

/** One shadow decision with what the master did (journal auto_order_shadow). */
export interface AutoOrderShadowRow {
  decision: 'yes' | 'no';
  reasons: readonly AutoOrderReason[];
  /**
   * The master ordered the order as it was: the recheck let «Проверить и заказать» send it to the
   * supplier, or he pressed «Заказать всё равно» after the problem.
   */
  masterOrdered: boolean;
}

export interface AutoOrderStats {
  /** M: shadow decisions. */
  decisions: number;
  yes: number;
  no: number;
  /** N: the master did the same as the shadow (ordered after «ДА», did not after «НЕТ»). */
  agreements: number;
  /** «ДА», but the master did not order: the dangerous disagreement. */
  yesNotOrdered: number;
  /** «НЕТ», but the master ordered anyway: the shadow was more careful than him. */
  noButOrdered: number;
  /** How often each reason stopped the shadow. */
  reasons: Record<AutoOrderReason, number>;
}

export function autoOrderStats(rows: readonly AutoOrderShadowRow[]): AutoOrderStats {
  const reasons = Object.fromEntries(AUTO_ORDER_REASONS.map((r) => [r, 0])) as Record<
    AutoOrderReason,
    number
  >;
  const stats: AutoOrderStats = {
    decisions: rows.length,
    yes: 0,
    no: 0,
    agreements: 0,
    yesNotOrdered: 0,
    noButOrdered: 0,
    reasons,
  };
  for (const row of rows) {
    if (row.decision === 'yes') {
      stats.yes += 1;
      if (row.masterOrdered) stats.agreements += 1;
      else stats.yesNotOrdered += 1;
    } else {
      stats.no += 1;
      if (row.masterOrdered) stats.noButOrdered += 1;
      else stats.agreements += 1;
    }
    for (const reason of new Set(row.reasons)) reasons[reason] += 1;
  }
  return stats;
}

export type AutoOrderVerdictKind = 'few' | 'early' | 'discuss';

/**
 * The plain-language verdict: «совпадений N из M — можно обсуждать автозаказ» only with at least
 * 30 decisions and at least 95 % agreement; «мало данных» with fewer decisions; «рано» otherwise.
 * There is no switch: the decision to turn the real auto-order on stays with the founder.
 */
export function autoOrderVerdict(stats: Pick<AutoOrderStats, 'decisions' | 'agreements'>): {
  kind: AutoOrderVerdictKind;
  text: string;
} {
  const { decisions: m, agreements: n } = stats;
  const counts = `совпадений ${n} из ${m}`;
  if (m < AUTO_ORDER_VERDICT_MIN_DECISIONS) {
    return {
      kind: 'few',
      text: `Мало данных: ${counts}, нужно хотя бы ${AUTO_ORDER_VERDICT_MIN_DECISIONS} решений.`,
    };
  }
  if (n * 100 >= AUTO_ORDER_VERDICT_MIN_AGREEMENT_PCT * m) {
    return { kind: 'discuss', text: `${capitalize(counts)} — можно обсуждать автозаказ.` };
  }
  return {
    kind: 'early',
    text: `Рано: ${counts}, нужно не меньше ${AUTO_ORDER_VERDICT_MIN_AGREEMENT_PCT}%.`,
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * «Мастер заказал» of a shadow decision for the statistics: ordered by the press itself
 * (payload.masterOrdered), or «Заказать всё равно» (order_anyway) of the same order after the
 * decision and before its next one.
 */
export function shadowMasterOrdered(
  shadow: { orderId: string; at: Date; masterOrdered: boolean; nextAt: Date | null },
  orderedAnyway: readonly { orderId: string; at: Date }[],
): boolean {
  if (shadow.masterOrdered) return true;
  return orderedAnyway.some(
    (event) =>
      event.orderId === shadow.orderId &&
      event.at.getTime() > shadow.at.getTime() &&
      (shadow.nextAt === null || event.at.getTime() < shadow.nextAt.getTime()),
  );
}
