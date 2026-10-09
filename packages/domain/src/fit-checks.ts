/**
 * Step 4 (docs/fit-check.md, audit roadmap r07): «Проверим, подойдёт ли». The client sends cart
 * lines with the VIN of the car; the master answers each line in the seller bot (it fits, an
 * analog fits, it does not fit, a call is needed). Pure functions: the status transitions, what a
 * cart line shows, which lines count as checked at checkout, the SLA in working hours of the
 * pickup point, the client's promise text and the admin statistics. The clock, the zone and the
 * working hours are passed in.
 *
 * Founder decisions (fixed): a check only with a VIN; the master answers within 30–60 minutes in
 * the working hours of the pickup point (PICKUP_HOURS); the guarantee wording is not decided yet,
 * so nothing here promises money back — FIT_GUARANTEE_ENABLED decides that on the pages.
 */
import { MAX_CART_LINES } from './cart';
import { addDays, CLIENT_TIME_ZONE, localDate } from './dates';
import { isoWeekday, zonedInstant, zonedWallTime } from './install-window';
import {
  FIT_CHECK_ANSWERS,
  FIT_CHECK_STATUSES,
  isOneOf,
  type ClaimKind,
  type FitCheckAnswer,
  type FitCheckStatus,
} from './statuses';
import type { IsoDate } from './types';
import type { WeekSchedule } from './work-hours';

/** «Комментарий для мастера», characters (CHECK in the database). */
export const FIT_CHECK_COMMENT_MAX = 200;
/**
 * The shortest life of a check nobody answered: 24 hours after it was sent. With the working
 * hours of the pickup point it lives longer — to the closing of the next working day
 * (fitCheckExpiresAt, fit_checks.expires_at).
 */
export const FIT_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
/** fit_checks.vin and comment are cleared this many days after the request (as VIN photos). */
export const FIT_CHECK_RETENTION_DAYS = 90;
/** settings `fit_check.sla_minutes`: the master answers within an hour of working time. */
export const DEFAULT_FIT_CHECK_SLA_MINUTES = 60;
/** The settings key of the SLA (SettingsValues). */
export const FIT_CHECK_SLA_KEY = 'fit_check.sla_minutes';
/** Bounds of the SLA the admin may set, minutes. */
export const FIT_CHECK_SLA_MIN_MINUTES = 5;
export const FIT_CHECK_SLA_MAX_MINUTES = 24 * 60;
/** Lines of one request: a whole cart at most. */
export const FIT_CHECK_LINES_MAX = MAX_CART_LINES;
/** Requests of one cart per 24 hours (the web rate limit). */
export const FIT_CHECK_REQUESTS_PER_CART_DAY = 10;
/** Requests of one client IP bucket per 24 hours (the web rate limit). */
export const FIT_CHECK_REQUESTS_PER_IP_DAY = 20;

const MINUTE_MS = 60_000;
/** Days scanned forward or across a range (a schedule has a working day every week). */
const MAX_SCAN_DAYS = 400;

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export function isFitCheckStatus(value: unknown): value is FitCheckStatus {
  return isOneOf(FIT_CHECK_STATUSES, value);
}

export function isFitCheckAnswer(value: unknown): value is FitCheckAnswer {
  return isOneOf(FIT_CHECK_ANSWERS, value);
}

/**
 * A check moves only out of `pending` (an answer, expiry, cancellation); every other status is
 * final: asking again makes a new row of a new request.
 */
export function canTransitionFitCheck(from: FitCheckStatus, to: FitCheckStatus): boolean {
  return from === 'pending' && to !== 'pending';
}

/** Statuses as staff read them (bot card, admin). */
export const FIT_CHECK_STATUS_LABELS: Readonly<Record<FitCheckStatus, string>> = {
  pending: 'ждёт ответа',
  fits: 'подходит',
  analog: 'аналог',
  not_fit: 'не подходит',
  call_needed: 'нужен звонок',
  expired: 'не успели ответить',
  cancelled: 'отменена',
};

/** The master's buttons (seller bot, admin). */
export const FIT_CHECK_ANSWER_LABELS: Readonly<Record<FitCheckAnswer, string>> = {
  fits: 'Подходит',
  analog: 'Аналог',
  not_fit: 'Не подходит',
  call_needed: 'Нужен звонок',
};

/**
 * Short number of a request for the sellers card and the admin: the last 6 hex digits of its
 * uuid v7 (the random part), upper case.
 */
export function fitRequestNumber(requestId: string): string {
  return requestId.replace(/-/gu, '').slice(-6).toUpperCase();
}

/** The comment for the master: trimmed, whitespace runs as one space; empty -> null. */
export function cleanFitComment(text: string | null | undefined): string | null {
  const clean = (text ?? '').replace(/\s+/gu, ' ').trim();
  return clean === '' ? null : clean;
}

// ---------------------------------------------------------------------------
// A cart line and its check
// ---------------------------------------------------------------------------

/** A part as brand and article (a cart line, a check snapshot, an analog). */
export interface FitPart {
  brand: string;
  article: string;
}

function partKey(part: FitPart): string {
  const clean = (value: string) => value.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return `${clean(part.brand)}|${clean(part.article)}`;
}

/** Same brand and article, case, spaces and punctuation ignored ('W 914/2' = 'W914/2'). */
export function samePart(a: FitPart, b: FitPart): boolean {
  return partKey(a) === partKey(b);
}

/** What the state of a line depends on: the latest check of the line. */
export interface FitCheckFacts {
  status: FitCheckStatus;
  /** Snapshot of the line when it was sent. */
  brand: string;
  article: string;
  analogBrand: string | null;
  analogArticle: string | null;
  /** «Оставить как есть» was pressed on the analog. */
  analogKeptAt: Date | null;
  expiresAt: Date;
}

/**
 * What a cart line shows:
 * - none: never checked, a cancelled check, or the line changed after the check (another
 *   offer, brand or article: the check was about another part, it is lost);
 * - pending: the master checks (until expires_at; past it the line reads `expired` even before
 *   the worker marks it);
 * - fits: «Проверено мастером»;
 * - analog_offer: the master offers an analog («Заменить» / «Оставить как есть»);
 * - analog_accepted: the line was replaced by the analog — checked, like `fits`;
 * - analog_kept: the client kept the original part — not checked;
 * - not_fit, call_needed, expired.
 */
export type FitLineState =
  | 'none'
  | 'pending'
  | 'fits'
  | 'analog_offer'
  | 'analog_accepted'
  | 'analog_kept'
  | 'not_fit'
  | 'call_needed'
  | 'expired';

export function fitLineState(check: FitCheckFacts | null, line: FitPart, now: Date): FitLineState {
  if (check === null) return 'none';
  if (
    check.status === 'analog' &&
    check.analogBrand !== null &&
    check.analogArticle !== null &&
    samePart({ brand: check.analogBrand, article: check.analogArticle }, line)
  ) {
    return 'analog_accepted';
  }
  if (!samePart(check, line)) return 'none';
  switch (check.status) {
    case 'pending':
      return now.getTime() >= check.expiresAt.getTime() ? 'expired' : 'pending';
    case 'fits':
      return 'fits';
    case 'analog':
      return check.analogKeptAt !== null ? 'analog_kept' : 'analog_offer';
    case 'not_fit':
      return 'not_fit';
    case 'call_needed':
      return 'call_needed';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'none';
  }
}

/**
 * The line counts as checked by the master: checkout copies the check into order_items
 * (fit_check_id, fit_checked_at, fit_checked_by, fit_guarantee). Only `fits` and an accepted
 * analog; an answer about another part (the line changed since) never counts.
 */
export function isFitCheckedState(state: FitLineState): boolean {
  return state === 'fits' || state === 'analog_accepted';
}

/** A line may go to the master now: not while a check of it waits for an answer. */
export function canRequestFitCheck(state: FitLineState): boolean {
  return state !== 'pending';
}

// ---------------------------------------------------------------------------
// Working hours: the SLA and the promise to the client
// ---------------------------------------------------------------------------

function instantOf(value: Date, name: string): number {
  const ms = value instanceof Date ? value.getTime() : Number.NaN;
  if (Number.isNaN(ms)) throw new RangeError(`invalid ${name}`);
  return ms;
}

function hasWeek(schedule: WeekSchedule | null | undefined): schedule is WeekSchedule {
  return schedule !== null && schedule !== undefined && schedule.length === 7;
}

/**
 * Minutes of working time of the pickup point in [from, to) (whole minutes, floor). Without a
 * schedule (PICKUP_HOURS not set or not understood) every minute counts: a reminder at night is
 * better than none.
 */
export function workingMinutesBetween(
  from: Date,
  to: Date,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): number {
  const start = instantOf(from, 'from');
  const end = instantOf(to, 'to');
  if (end <= start) return 0;
  if (!hasWeek(schedule)) return Math.floor((end - start) / MINUTE_MS);
  let total = 0;
  let date = localDate(from, timeZone);
  const last = localDate(to, timeZone);
  for (let i = 0; i <= MAX_SCAN_DAYS && date <= last; i += 1) {
    const hours = schedule[isoWeekday(date)];
    if (hours) {
      const open = Math.max(zonedInstant(date, hours.openMin, timeZone), start);
      const close = Math.min(zonedInstant(date, hours.closeMin, timeZone), end);
      if (close > open) total += close - open;
    }
    date = addDays(date, 1);
  }
  return Math.floor(total / MINUTE_MS);
}

/**
 * The moment `minutes` of working time have passed after `from` (0 minutes: the next working
 * moment). Without a schedule: `from + minutes`.
 */
export function addWorkingMinutes(
  from: Date,
  minutes: number,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): Date {
  const start = instantOf(from, 'from');
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError('minutes must be >= 0');
  if (!hasWeek(schedule)) return new Date(start + minutes * MINUTE_MS);
  let remaining = minutes * MINUTE_MS;
  let date = localDate(from, timeZone);
  for (let i = 0; i <= MAX_SCAN_DAYS; i += 1) {
    const hours = schedule[isoWeekday(date)];
    if (hours) {
      const open = Math.max(zonedInstant(date, hours.openMin, timeZone), start);
      const close = zonedInstant(date, hours.closeMin, timeZone);
      if (close > open) {
        if (remaining <= close - open) return new Date(open + remaining);
        remaining -= close - open;
      }
    }
    date = addDays(date, 1);
  }
  return new Date(start + minutes * MINUTE_MS);
}

/** `now` while the point is open, otherwise its next opening; null without a schedule. */
export function nextWorkingStart(
  now: Date,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): Date | null {
  const nowMs = instantOf(now, 'now');
  if (!hasWeek(schedule)) return null;
  let date = localDate(now, timeZone);
  for (let i = 0; i <= 8; i += 1) {
    const hours = schedule[isoWeekday(date)];
    if (hours) {
      const close = zonedInstant(date, hours.closeMin, timeZone);
      if (nowMs < close)
        return new Date(Math.max(zonedInstant(date, hours.openMin, timeZone), nowMs));
    }
    date = addDays(date, 1);
  }
  return null;
}

/**
 * When a check nobody answered expires (fit_checks.expires_at): the closing time of the next
 * working day of the pickup point after the day it was sent, and never earlier than 24 hours
 * after it was sent. The master always gets a whole working day: a request of Saturday 18:30
 * waits until Monday's closing when Sunday is a day off (with wall-clock 24 hours it would
 * expire on Sunday, before anybody could see it). Without a schedule (PICKUP_HOURS not set or
 * not understood): 24 hours.
 */
export function fitCheckExpiresAt(
  createdAt: Date,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): Date {
  const dayLater = instantOf(createdAt, 'createdAt') + FIT_CHECK_TTL_MS;
  if (!hasWeek(schedule)) return new Date(dayLater);
  // Calendar days after the day of sending (in the zone of the point): the first one open.
  let date = addDays(localDate(createdAt, timeZone), 1);
  for (let i = 0; i < 7; i += 1) {
    const hours = schedule[isoWeekday(date)];
    if (hours) return new Date(Math.max(zonedInstant(date, hours.closeMin, timeZone), dayLater));
    date = addDays(date, 1);
  }
  // A week without a working day: as without a schedule.
  return new Date(dayLater);
}

/** The request waits for an answer longer than the SLA, counted in working minutes. */
export function fitCheckOverdue(
  createdAt: Date,
  now: Date,
  slaMinutes: number,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): boolean {
  return workingMinutesBetween(createdAt, now, schedule, timeZone) >= slaMinutes;
}

/**
 * When the master will answer, as the client is told (founder decision: 30–60 minutes in the
 * working hours):
 * - soon: the point is open and the SLA ends today — «в течение часа»;
 * - later: the point is closed (or closes before the SLA ends) — the next opening;
 * - unknown: the working hours are not understood.
 */
export type FitCheckPromise =
  | { kind: 'soon'; slaMinutes: number }
  | {
      kind: 'later';
      /** Local date of the opening. */
      date: IsoDate;
      day: 'today' | 'tomorrow' | 'later';
      /** '10:00' */
      openText: string;
      /** Opens before noon: «утром». */
      morning: boolean;
    }
  | { kind: 'unknown' };

function clockText(minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(Math.floor(minutes % 60)).padStart(2, '0');
  return `${hh}:${mm}`;
}

function laterPromise(start: Date, today: IsoDate, timeZone: string): FitCheckPromise {
  const { date, minutes } = zonedWallTime(start.getTime(), timeZone);
  const day = date === today ? 'today' : date === addDays(today, 1) ? 'tomorrow' : 'later';
  return { kind: 'later', date, day, openText: clockText(minutes), morning: minutes < 12 * 60 };
}

export function fitCheckPromise(
  now: Date,
  slaMinutes: number,
  schedule: WeekSchedule | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): FitCheckPromise {
  const start = nextWorkingStart(now, schedule, timeZone);
  if (start === null || !hasWeek(schedule)) return { kind: 'unknown' };
  const today = localDate(now, timeZone);
  if (start.getTime() !== now.getTime()) return laterPromise(start, today, timeZone);
  const due = addWorkingMinutes(now, slaMinutes, schedule, timeZone);
  if (localDate(due, timeZone) === today) return { kind: 'soon', slaMinutes };
  // Open now, but the point closes before the SLA ends: promise the next opening.
  const hours = schedule[isoWeekday(today)];
  const close = hours ? zonedInstant(today, hours.closeMin, timeZone) : now.getTime();
  const next = nextWorkingStart(new Date(close), schedule, timeZone);
  return next === null ? { kind: 'unknown' } : laterPromise(next, today, timeZone);
}

const WEEKDAYS_ACCUSATIVE = [
  'в воскресенье',
  'в понедельник',
  'во вторник',
  'в среду',
  'в четверг',
  'в пятницу',
  'в субботу',
] as const;

function withinText(slaMinutes: number): string {
  if (slaMinutes <= 60) return 'в течение часа';
  const hours = Math.ceil(slaMinutes / 60);
  // «в течение 21 часа», «в течение 2 часов» (genitive after «в течение»).
  const noun = hours % 10 === 1 && hours % 100 !== 11 ? 'часа' : 'часов';
  return `в течение ${hours} ${noun}`;
}

function whenText(promise: Extract<FitCheckPromise, { kind: 'later' }>): string {
  const weekday = WEEKDAYS_ACCUSATIVE[isoWeekday(promise.date)] as string;
  if (promise.morning) {
    return promise.day === 'later'
      ? `${weekday} утром — с ${promise.openText}`
      : `утром — с ${promise.openText}`;
  }
  const day = promise.day === 'today' ? 'сегодня' : promise.day === 'tomorrow' ? 'завтра' : weekday;
  return `${day} — с ${promise.openText}`;
}

/** Under «Отправить мастеру»: «Мастер проверит в течение часа» / «Проверим утром — с 10:00». */
export function fitCheckPromiseText(promise: FitCheckPromise): string {
  switch (promise.kind) {
    case 'soon':
      return `Мастер проверит ${withinText(promise.slaMinutes)}`;
    case 'later':
      return `Проверим ${whenText(promise)}`;
    case 'unknown':
      return 'Мастер проверит в рабочее время';
  }
}

/** A pending line: «Мастер проверяет · ответит в течение часа». */
export function fitCheckPendingText(promise: FitCheckPromise): string {
  switch (promise.kind) {
    case 'soon':
      return `Мастер проверяет · ответит ${withinText(promise.slaMinutes)}`;
    case 'later':
      return `Мастер проверяет · ответит ${whenText(promise)}`;
    case 'unknown':
      return 'Мастер проверяет · ответит в рабочее время';
  }
}

// ---------------------------------------------------------------------------
// Admin statistics (/admin/fit-checks)
// ---------------------------------------------------------------------------

export interface FitCheckStatRow {
  requestId: string;
  status: FitCheckStatus;
  createdAt: Date;
  answeredAt: Date | null;
  /** The line went into an order that is paid (order_items.fit_check_id, orders.paid_at). */
  paid: boolean;
}

export interface FitCheckStats {
  requests: number;
  lines: number;
  byStatus: Record<FitCheckStatus, number>;
  /** Lines with an answer of the master. */
  answered: number;
  /** Median answer time in working minutes of the point; null without answers. */
  medianAnswerMinutes: number | null;
  /** Answered within the SLA (working minutes). */
  withinSla: number;
  /** Lines the master checked: `fits` and `analog`. */
  checked: number;
  /** Checked lines that ended up in a paid order. */
  checkedPaid: number;
}

export function fitCheckStats(
  rows: readonly FitCheckStatRow[],
  input: {
    slaMinutes: number;
    schedule: WeekSchedule | null | undefined;
    timeZone?: string;
  },
): FitCheckStats {
  const timeZone = input.timeZone ?? CLIENT_TIME_ZONE;
  const byStatus = Object.fromEntries(FIT_CHECK_STATUSES.map((s) => [s, 0])) as Record<
    FitCheckStatus,
    number
  >;
  const answerMinutes: number[] = [];
  let withinSla = 0;
  let checked = 0;
  let checkedPaid = 0;
  for (const row of rows) {
    byStatus[row.status] += 1;
    if (isFitCheckAnswer(row.status) && row.answeredAt !== null) {
      const minutes = workingMinutesBetween(
        row.createdAt,
        row.answeredAt,
        input.schedule,
        timeZone,
      );
      answerMinutes.push(minutes);
      if (minutes <= input.slaMinutes) withinSla += 1;
    }
    if (row.status === 'fits' || row.status === 'analog') {
      checked += 1;
      if (row.paid) checkedPaid += 1;
    }
  }
  answerMinutes.sort((a, b) => a - b);
  const middle = Math.floor(answerMinutes.length / 2);
  const median =
    answerMinutes.length === 0
      ? null
      : answerMinutes.length % 2 === 1
        ? (answerMinutes[middle] as number)
        : Math.round(
            ((answerMinutes[middle - 1] as number) + (answerMinutes[middle] as number)) / 2,
          );
  return {
    requests: new Set(rows.map((row) => row.requestId)).size,
    lines: rows.length,
    byStatus,
    answered: answerMinutes.length,
    medianAnswerMinutes: median,
    withinSla,
    checked,
    checkedPaid,
  };
}

/** Percent of a whole, rounded; null for an empty whole. */
export function sharePercent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part * 100) / whole) : null;
}

// ---------------------------------------------------------------------------
// Claims: the fit guarantee label (information only, the staff decides)
// ---------------------------------------------------------------------------

export const FIT_GUARANTEE_CLAIM_LABEL = 'Гарантия подбора: мастер проверил под VIN';

/**
 * The label of a «не подошла» claim on an item ordered with the fit guarantee
 * (order_items.fit_guarantee: the master checked it and FIT_GUARANTEE_ENABLED was on). Nothing
 * else changes: the decision stays with the staff.
 */
export function fitGuaranteeClaimLabel(
  kind: ClaimKind,
  item: { fitGuarantee: boolean } | null,
): string | null {
  return kind === 'not_fit' && item?.fitGuarantee === true ? FIT_GUARANTEE_CLAIM_LABEL : null;
}
