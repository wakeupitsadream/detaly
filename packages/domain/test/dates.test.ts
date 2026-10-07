import { describe, expect, it } from 'vitest';
import {
  addDays,
  DateError,
  diffDays,
  etaDate,
  formatPromise,
  isIsoDate,
  localDate,
  nextPickupDay,
  parseSupplierTimestamp,
  parseWorkHours,
  promisedDate,
  weekdayShort,
} from '../src';
import type { StockInfo } from '../src/types';

const stock = (deliveryDays: number | null, deliveryEnd: string | null = null): StockInfo => ({
  stockId: 'S1',
  isLocal: false,
  count: 5,
  multiplicity: 1,
  type: null,
  deliveryDays,
  deliveryStart: null,
  deliveryEnd,
  extra: null,
  description: null,
});

const ETA = { bufferDays: 1, invoiceLagDays: 1, prepayInvoice: false };

describe('localDate', () => {
  it('uses Asia/Yekaterinburg (UTC+5) by default', () => {
    expect(localDate(new Date('2026-10-01T18:59:59Z'))).toBe('2026-10-01');
    expect(localDate(new Date('2026-10-01T19:00:00Z'))).toBe('2026-10-02');
    expect(localDate(new Date('2026-10-01T20:30:00Z'))).toBe('2026-10-02');
  });

  it('accepts another zone', () => {
    expect(localDate(new Date('2026-10-01T20:30:00Z'), 'Europe/Moscow')).toBe('2026-10-01');
    expect(localDate(new Date('2026-10-01T21:00:00Z'), 'Europe/Moscow')).toBe('2026-10-02');
  });

  it('rejects an invalid instant', () => {
    expect(() => localDate(new Date('nope'))).toThrow(DateError);
  });
});

describe('etaDate', () => {
  it('delivery 0 days: the client calendar day of now (UTC+5 boundary)', () => {
    expect(etaDate(stock(0), new Date('2026-10-01T18:59:59Z'))).toBe('2026-10-01');
    expect(etaDate(stock(0), new Date('2026-10-01T20:30:00Z'))).toBe('2026-10-02');
  });

  it('adds delivery days to the local date', () => {
    expect(etaDate(stock(3), new Date('2026-10-01T10:00:00Z'))).toBe('2026-10-04');
    expect(etaDate(stock(1), new Date('2026-12-31T10:00:00Z'))).toBe('2027-01-01');
  });

  it('prefers deliveryEnd and converts it to the client zone', () => {
    expect(etaDate(stock(30, '2026-10-08T22:00+03:00'), new Date('2026-10-01T10:00:00Z'))).toBe(
      '2026-10-09',
    );
    expect(etaDate(stock(30, '2026-10-08T20:59:59+03:00'), new Date('2026-10-01T10:00:00Z'))).toBe(
      '2026-10-08',
    );
  });

  it('deliveryEnd without offset is Moscow time (assumption to verify)', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    expect(etaDate(stock(30, '2026-10-08 22:00:00'), now)).toBe('2026-10-09');
    expect(etaDate(stock(30, '2026-10-08T21:59'), now)).toBe('2026-10-08');
    expect(etaDate(stock(30, '08.10.2026 22:00'), now)).toBe('2026-10-09');
  });

  it('date-only deliveryEnd is taken as that day', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    expect(etaDate(stock(30, '2026-10-08'), now)).toBe('2026-10-08');
    expect(etaDate(stock(30, '08.10.2026'), now)).toBe('2026-10-08');
  });

  it('a deliveryEnd in the past is clamped to today (no promise for a passed date)', () => {
    // 00:10 in Yekaterinburg on 10-02, cached deliveryEnd was 10-01 23:00 MSK (= 10-02 01:00+05)
    const now = new Date('2026-10-01T19:10:00Z');
    expect(etaDate(stock(0, '2026-10-01'), now)).toBe('2026-10-02');
    expect(etaDate(stock(0, '2026-09-30T12:00:00+03:00'), now)).toBe('2026-10-02');
    expect(etaDate(stock(0, '2026-10-01T23:00:00+03:00'), now)).toBe('2026-10-02');
  });

  it('falls back to deliveryDays when deliveryEnd is empty or unparseable', () => {
    const now = new Date('2026-10-01T10:00:00Z');
    expect(etaDate(stock(2, ''), now)).toBe('2026-10-03');
    expect(etaDate(stock(2, 'скоро'), now)).toBe('2026-10-03');
    expect(etaDate(stock(2, '2026-02-30'), now)).toBe('2026-10-03');
  });

  it('never invents a date: no days and an unparseable deliveryEnd throw', () => {
    const now = new Date('2026-10-02T05:00:00Z');
    expect(() => etaDate(stock(null, 'скоро'), now)).toThrow(DateError);
    expect(() => etaDate(stock(null, null), now)).toThrow(DateError);
    expect(etaDate(stock(null, '2026-10-08 22:00:00+03'), now)).toBe('2026-10-09');
    expect(etaDate(stock(null, '2026/10/08'), now)).toBe('2026-10-08');
  });

  it('rejects negative or fractional delivery days', () => {
    expect(() => etaDate(stock(-1), new Date())).toThrow(DateError);
    expect(() => etaDate(stock(1.5), new Date())).toThrow(DateError);
  });
});

describe('parseSupplierTimestamp', () => {
  it('understands Z, offsets with and without colon', () => {
    expect(parseSupplierTimestamp('2026-10-08T19:00:00Z')).toEqual({
      kind: 'instant',
      instant: new Date('2026-10-08T19:00:00Z'),
    });
    expect(parseSupplierTimestamp('2026-10-08T22:00:00+0300')).toEqual({
      kind: 'instant',
      instant: new Date('2026-10-08T19:00:00Z'),
    });
    expect(parseSupplierTimestamp('2026-10-08 22:00:00+03')).toEqual({
      kind: 'instant',
      instant: new Date('2026-10-08T19:00:00Z'),
    });
    expect(parseSupplierTimestamp('2026-10-08T22:00-0130')).toEqual({
      kind: 'instant',
      instant: new Date('2026-10-08T23:30:00Z'),
    });
    expect(parseSupplierTimestamp('2026/10/08')).toEqual({ kind: 'date', date: '2026-10-08' });
    expect(parseSupplierTimestamp('2026/10-08')).toBeNull();
    expect(parseSupplierTimestamp('скоро')).toBeNull();
    expect(parseSupplierTimestamp('2026-10-08T25:00:00')).toBeNull();
  });
});

describe('promisedDate', () => {
  it('max(eta) + buffer', () => {
    expect(promisedDate(['2026-10-05', '2026-10-08'], ETA)).toBe('2026-10-09');
  });

  it('adds the Rossko invoice lag when prepay invoice is on', () => {
    expect(promisedDate(['2026-10-05', '2026-10-08'], { ...ETA, prepayInvoice: true })).toBe(
      '2026-10-10',
    );
  });

  it('crosses the year boundary', () => {
    expect(promisedDate(['2026-12-31'], ETA)).toBe('2027-01-01');
  });

  it('rejects empty and invalid input', () => {
    expect(() => promisedDate([], ETA)).toThrow(DateError);
    expect(() => promisedDate(['2026-13-01'], ETA)).toThrow(DateError);
    expect(() => promisedDate(['2026-10-01'], { ...ETA, bufferDays: -1 })).toThrow(DateError);
  });
});

describe('promisedDate on the days the pickup point works', () => {
  const weekdays = parseWorkHours('Пн–Пт 10:00–19:00');
  const sixDays = parseWorkHours('Пн–Сб 9:00–19:00');
  const at = (bufferDays: number, schedule: typeof weekdays) =>
    promisedDate(['2026-10-07'], { ...ETA, bufferDays, pickupSchedule: schedule });

  it('moves Saturday and Sunday to Monday when the point works Mon–Fri', () => {
    // Wed 7 Oct + 3 = Sat 10 Oct -> Mon 12 Oct
    expect(at(3, weekdays)).toBe('2026-10-12');
    expect(weekdayShort(at(3, weekdays))).toBe('пн');
    expect(at(4, weekdays)).toBe('2026-10-12'); // Sunday
    expect(at(2, weekdays)).toBe('2026-10-09'); // Friday stays
    expect(at(5, weekdays)).toBe('2026-10-12'); // Monday stays
  });

  it('keeps Saturday and moves only Sunday when the point works Mon–Sat', () => {
    expect(at(3, sixDays)).toBe('2026-10-10');
    expect(at(4, sixDays)).toBe('2026-10-12');
  });

  it('adds the invoice lag before moving to a working day', () => {
    // Thu 8 Oct + 1 buffer + 1 lag = Sat 10 Oct -> Mon 12 Oct
    expect(
      promisedDate(['2026-10-08'], { ...ETA, prepayInvoice: true, pickupSchedule: weekdays }),
    ).toBe('2026-10-12');
  });

  it('does not move the date without a schedule or with hours not understood', () => {
    expect(at(3, null)).toBe('2026-10-10');
    expect(promisedDate(['2026-10-07'], { ...ETA, bufferDays: 3 })).toBe('2026-10-10');
    expect(parseWorkHours('')).toBeNull();
    expect(at(3, parseWorkHours(''))).toBe('2026-10-10');
    expect(at(3, parseWorkHours('по договорённости'))).toBe('2026-10-10');
  });

  it('nextPickupDay never goes further than 14 days', () => {
    const closed = [null, null, null, null, null, null, null];
    expect(nextPickupDay('2026-10-10', closed)).toBe('2026-10-10');
    const sundayOnly = parseWorkHours('Вс 10-16');
    expect(nextPickupDay('2026-10-12', sundayOnly)).toBe('2026-10-18');
  });
});

describe('formatPromise', () => {
  it("'2026-10-08' -> 'к чт 8 октября' (1 Oct 2026 is a Thursday)", () => {
    expect(formatPromise('2026-10-08')).toBe('к чт 8 октября');
    expect(formatPromise('2026-10-01')).toBe('к чт 1 октября');
  });

  it('covers every weekday and month name', () => {
    expect(formatPromise('2026-10-04')).toBe('к вс 4 октября');
    expect(formatPromise('2026-10-05')).toBe('к пн 5 октября');
    expect(formatPromise('2027-01-01')).toBe('к пт 1 января');
    expect(formatPromise('2027-02-28')).toBe('к вс 28 февраля');
    expect(formatPromise('2026-05-09')).toBe('к сб 9 мая');
    expect(formatPromise('2026-08-19')).toBe('к ср 19 августа');
    expect(formatPromise('2026-12-01')).toBe('к вт 1 декабря');
  });

  it('rejects invalid dates', () => {
    expect(() => formatPromise('2026-02-29')).toThrow(DateError);
  });
});

describe('date helpers', () => {
  it('isIsoDate validates the calendar', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-1-01')).toBe(false);
    expect(isIsoDate(20261001)).toBe(false);
  });

  it('addDays / diffDays', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-10-01', '2026-10-11')).toBe(10);
    expect(diffDays('2026-10-11', '2026-10-01')).toBe(-10);
  });
});
