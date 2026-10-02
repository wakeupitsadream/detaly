/**
 * Calendar dates for client promises. All functions are pure: `now` is always passed in.
 * Client-facing dates are calendar days in Asia/Yekaterinburg (UTC+5, Orenburg time).
 * Rossko timestamps without an offset are assumed to be Moscow time (UTC+3); this assumption
 * must be verified against real GetSearch responses.
 */
import type { EtaSettings, IsoDate, StockInfo } from './types';

export const CLIENT_TIME_ZONE = 'Asia/Yekaterinburg';
/** Offset applied to supplier timestamps that carry no zone. */
export const SUPPLIER_DEFAULT_OFFSET = '+03:00';

const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class DateError extends RangeError {
  override name = 'DateError';
}

/** Strict 'YYYY-MM-DD' check including the day of month. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE_RE.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function isoToUtcMs(date: IsoDate): number {
  if (!isIsoDate(date)) throw new DateError(`invalid date '${String(date)}'`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function utcMsToIso(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Adds whole calendar days (may be negative). '2026-12-31' + 1 -> '2027-01-01'. */
export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isSafeInteger(days)) throw new DateError('days must be an integer');
  return utcMsToIso(isoToUtcMs(date) + days * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function diffDays(from: IsoDate, to: IsoDate): number {
  return Math.round((isoToUtcMs(to) - isoToUtcMs(from)) / DAY_MS);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Calendar date of an instant in `timeZone` (default Asia/Yekaterinburg). */
export function localDate(instant: Date, timeZone: string = CLIENT_TIME_ZONE): IsoDate {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new DateError('invalid instant');
  }
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const SUPPLIER_DATE_ONLY_RE = /^(\d{4})([-/])(\d{2})\2(\d{2})$/;
const SUPPLIER_RU_DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const SUPPLIER_ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** '+03' -> '+03:00', '+0300' -> '+03:00'; 'Z' and '+03:00' stay as they are. */
function normalizeOffset(zone: string): string {
  if (zone === 'Z' || zone.includes(':')) return zone;
  return zone.length === 3 ? `${zone}:00` : `${zone.slice(0, 3)}:${zone.slice(3)}`;
}

/**
 * Parses a supplier timestamp. Returns either an exact instant or, for a bare date, the
 * calendar date itself (a date-only value is taken as that day). Returns null when the value
 * is not understood; callers then fall back to the delivery term in days.
 */
export function parseSupplierTimestamp(
  raw: string,
): { kind: 'instant'; instant: Date } | { kind: 'date'; date: IsoDate } | null {
  const value = raw.trim();
  const dateOnly = SUPPLIER_DATE_ONLY_RE.exec(value);
  if (dateOnly !== null) {
    const date = `${dateOnly[1]}-${dateOnly[3]}-${dateOnly[4]}`;
    return isIsoDate(date) ? { kind: 'date', date } : null;
  }

  const ru = SUPPLIER_RU_DATE_RE.exec(value);
  if (ru !== null) {
    const date = `${ru[3]}-${ru[2]}-${ru[1]}`;
    if (!isIsoDate(date)) return null;
    if (ru[4] === undefined) return { kind: 'date', date };
    return toInstant(date, ru[4], ru[5] ?? '00', ru[6] ?? '00', SUPPLIER_DEFAULT_OFFSET);
  }

  const iso = SUPPLIER_ISO_RE.exec(value);
  if (iso !== null) {
    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (!isIsoDate(date)) return null;
    const zone = normalizeOffset(iso[7] ?? SUPPLIER_DEFAULT_OFFSET);
    return toInstant(date, iso[4] ?? '00', iso[5] ?? '00', iso[6] ?? '00', zone);
  }
  return null;
}

function toInstant(
  date: IsoDate,
  hh: string,
  mm: string,
  ss: string,
  zone: string,
): { kind: 'instant'; instant: Date } | null {
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) return null;
  const instant = new Date(`${date}T${hh}:${mm}:${ss}${zone}`);
  return Number.isNaN(instant.getTime()) ? null : { kind: 'instant', instant };
}

/**
 * Expected arrival date of one stock offer in the client time zone: `deliveryEnd` when present
 * and parseable, otherwise the client's local date of `now` plus `deliveryDays`. Without both
 * (deliveryDays null and deliveryEnd missing or not understood) it throws DateError: a date is
 * never invented, buildOfferViews drops such stocks. A
 * `deliveryEnd` already in the past (a cached answer read after midnight) is clamped to today,
 * so a promise is never made for a date that has passed.
 */
export function etaDate(
  stock: Pick<StockInfo, 'deliveryDays' | 'deliveryEnd'>,
  now: Date,
  timeZone: string = CLIENT_TIME_ZONE,
): IsoDate {
  if (stock.deliveryEnd !== null && stock.deliveryEnd.trim() !== '') {
    const parsed = parseSupplierTimestamp(stock.deliveryEnd);
    const date =
      parsed?.kind === 'date'
        ? parsed.date
        : parsed?.kind === 'instant'
          ? localDate(parsed.instant, timeZone)
          : null;
    if (date !== null) {
      const today = localDate(now, timeZone);
      return date < today ? today : date;
    }
  }
  const days = stock.deliveryDays;
  if (days === null)
    throw new DateError('no delivery term: deliveryEnd is missing or not understood');
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new DateError('deliveryDays must be a non-negative integer');
  }
  return addDays(localDate(now, timeZone), days);
}

/**
 * Promised date of an order: max(eta) + bufferDays (+ invoiceLagDays when Rossko ships only
 * after its invoice is paid).
 */
export function promisedDate(etaDates: readonly IsoDate[], settings: EtaSettings): IsoDate {
  if (etaDates.length === 0) throw new DateError('no eta dates');
  let latest: IsoDate | null = null;
  for (const date of etaDates) {
    if (!isIsoDate(date)) throw new DateError(`invalid date '${String(date)}'`);
    if (latest === null || date > latest) latest = date;
  }
  const { bufferDays, invoiceLagDays, prepayInvoice } = settings;
  if (!Number.isSafeInteger(bufferDays) || bufferDays < 0) {
    throw new DateError('bufferDays must be a non-negative integer');
  }
  if (prepayInvoice && (!Number.isSafeInteger(invoiceLagDays) || invoiceLagDays < 0)) {
    throw new DateError('invoiceLagDays must be a non-negative integer');
  }
  return addDays(latest as IsoDate, bufferDays + (prepayInvoice ? invoiceLagDays : 0));
}

const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const;
const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

/** Short weekday of a calendar date: '2026-10-08' -> 'чт'. */
export function weekdayShort(date: IsoDate): string {
  return WEEKDAYS_SHORT[new Date(isoToUtcMs(date)).getUTCDay()] as string;
}

/** '2026-10-08' -> '8 октября'. */
export function formatDayMonth(date: IsoDate): string {
  const d = new Date(isoToUtcMs(date));
  return `${d.getUTCDate()} ${MONTHS_GENITIVE[d.getUTCMonth()] as string}`;
}

/** '2026-10-08' -> 'к чт 8 октября' (own arrays, no ICU). */
export function formatPromise(date: IsoDate): string {
  return `к ${weekdayShort(date)} ${formatDayMonth(date)}`;
}
