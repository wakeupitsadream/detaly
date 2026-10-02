import { describe, expect, it } from 'vitest';
import {
  dayLoadStrip,
  demoLoadSnapshot,
  parseWorkHours,
  planInstallWindow,
  zonedInstant,
  zonedWallTime,
  type LoadSnapshot,
} from '../src';

const TZ = 'Asia/Yekaterinburg';
const WEEKDAYS = parseWorkHours('Пн–Пт 10:00–19:00');
const WITH_SATURDAY = parseWorkHours('Пн-Пт 9:00-19:00, Сб 10:00-16:00');

/** Local Orenburg wall time (UTC+5) as a Date. */
const at = (date: string, time: string) => new Date(`${date}T${time}:00+05:00`);

const FREE: LoadSnapshot = () => ({ booked: 0, capacity: 2 });

/** Busy (booked = capacity) for the listed local "YYYY-MM-DD HH" hours. */
function busy(...hours: string[]): LoadSnapshot {
  const set = new Set(hours);
  return (ms) => {
    const { date, minutes } = zonedWallTime(ms, TZ);
    const key = `${date} ${String(Math.floor(minutes / 60)).padStart(2, '0')}`;
    return { booked: set.has(key) ? 2 : 0, capacity: 2 };
  };
}

function plan(etaDate: string, now: Date, load: LoadSnapshot = FREE, schedule = WEEKDAYS) {
  const result = planInstallWindow({ etaDate, now, timeZone: TZ, schedule, load });
  return (
    result && {
      readyAt: result.readyAt.toISOString(),
      slotStart: result.slotStart.toISOString(),
      carReadyAt: result.carReadyAt.toISOString(),
    }
  );
}

describe('planInstallWindow', () => {
  it('part today, morning: the delivery reaches the point by noon, slot at 12:00', () => {
    // Monday 2026-10-05, 08:00 local.
    expect(plan('2026-10-05', at('2026-10-05', '08:00'))).toEqual({
      readyAt: at('2026-10-05', '12:00').toISOString(),
      slotStart: at('2026-10-05', '12:00').toISOString(),
      carReadyAt: at('2026-10-05', '14:00').toISOString(),
    });
  });

  it('part already at the point in the afternoon: now + lead, rounded up to the hour', () => {
    expect(plan('2026-10-05', at('2026-10-05', '14:20'))?.slotStart).toBe(
      at('2026-10-05', '16:00').toISOString(),
    );
  });

  it('part today after closing: the next working morning', () => {
    expect(plan('2026-10-05', at('2026-10-05', '18:30'))?.slotStart).toBe(
      at('2026-10-06', '10:00').toISOString(),
    );
  });

  it('Friday evening goes to Monday', () => {
    // Friday 2026-10-02 17:30: ready 18:30, 19:00 + 2 h does not fit, the weekend is off.
    expect(plan('2026-10-02', at('2026-10-02', '17:30'))?.slotStart).toBe(
      at('2026-10-05', '10:00').toISOString(),
    );
  });

  it('a short Saturday: the job must end by 16:00', () => {
    // Saturday 2026-10-03.
    expect(plan('2026-10-03', at('2026-10-03', '08:00'), FREE, WITH_SATURDAY)?.slotStart).toBe(
      at('2026-10-03', '12:00').toISOString(),
    );
    // 14:30 -> ready 15:30 -> 16:00 + 2 h is past closing -> Monday at opening (9:00).
    expect(plan('2026-10-03', at('2026-10-03', '14:30'), FREE, WITH_SATURDAY)?.slotStart).toBe(
      at('2026-10-05', '09:00').toISOString(),
    );
  });

  it('skips a slot whose any hour is fully booked', () => {
    // 12:00-14:00 touches 13:00, which is full: 14:00 is the first free two hours.
    expect(plan('2026-10-05', at('2026-10-05', '08:00'), busy('2026-10-05 13'))?.slotStart).toBe(
      at('2026-10-05', '14:00').toISOString(),
    );
    // One lift of two taken is still a free lift.
    const half: LoadSnapshot = () => ({ booked: 1, capacity: 2 });
    expect(plan('2026-10-05', at('2026-10-05', '08:00'), half)?.slotStart).toBe(
      at('2026-10-05', '12:00').toISOString(),
    );
  });

  it('a fully booked day moves to the next one', () => {
    const monday = Array.from({ length: 24 }, (_, i) => `2026-10-05 ${String(i).padStart(2, '0')}`);
    expect(plan('2026-10-05', at('2026-10-05', '08:00'), busy(...monday))?.slotStart).toBe(
      at('2026-10-06', '10:00').toISOString(),
    );
  });

  it('no plan when the job never fits the day or nothing is free within the horizon', () => {
    expect(
      planInstallWindow({
        etaDate: '2026-10-05',
        now: at('2026-10-05', '08:00'),
        timeZone: TZ,
        schedule: WEEKDAYS,
        load: FREE,
        options: { jobMin: 600 },
      }),
    ).toBeNull();
    const full: LoadSnapshot = () => ({ booked: 2, capacity: 2 });
    expect(plan('2026-10-05', at('2026-10-05', '08:00'), full)).toBeNull();
  });

  it('unparsed working hours give no plan', () => {
    expect(
      planInstallWindow({
        etaDate: '2026-10-05',
        now: at('2026-10-05', '08:00'),
        schedule: parseWorkHours('по договорённости'),
        load: FREE,
      }),
    ).toBeNull();
  });

  it('works in Orenburg time when UTC is still on the previous day', () => {
    // 2026-10-05 19:30 UTC is already Tuesday 00:30 in Orenburg.
    const now = new Date('2026-10-05T19:30:00Z');
    const result = plan('2026-10-05', now);
    expect(result?.readyAt).toBe(at('2026-10-06', '01:30').toISOString());
    expect(result?.slotStart).toBe(at('2026-10-06', '10:00').toISOString());
  });

  it('marks the load kind and rejects broken input', () => {
    const demo = planInstallWindow({
      etaDate: '2026-10-05',
      now: at('2026-10-05', '08:00'),
      schedule: WEEKDAYS,
      load: FREE,
      loadKind: 'demo',
    });
    expect(demo?.loadKind).toBe('demo');
    expect(() =>
      planInstallWindow({ etaDate: '2026-13-01', now: new Date(), schedule: WEEKDAYS, load: FREE }),
    ).toThrow(RangeError);
    expect(() =>
      planInstallWindow({
        etaDate: '2026-10-05',
        now: new Date(),
        schedule: WEEKDAYS,
        load: FREE,
        options: { stepMin: 0 },
      }),
    ).toThrow(RangeError);
  });
});

describe('zoned time helpers', () => {
  it('round-trips local wall time in Orenburg', () => {
    const ms = zonedInstant('2026-10-08', 14 * 60, TZ);
    expect(new Date(ms).toISOString()).toBe('2026-10-08T09:00:00.000Z');
    expect(zonedWallTime(ms, TZ)).toEqual({ date: '2026-10-08', minutes: 840 });
  });
});

describe('dayLoadStrip', () => {
  it('lists working hours of the slot day and marks the slot', () => {
    const load = demoLoadSnapshot({ schedule: WEEKDAYS, timeZone: TZ });
    const result = planInstallWindow({
      etaDate: '2026-10-08',
      now: at('2026-10-02', '12:00'),
      timeZone: TZ,
      schedule: WEEKDAYS,
      load,
      loadKind: 'demo',
    });
    expect(result).not.toBeNull();
    const strip = dayLoadStrip(result!, WEEKDAYS!, load, TZ);
    expect(strip.map((c) => c.hour)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(strip.filter((c) => c.inSlot)).toHaveLength(2);
    for (const cell of strip.filter((c) => c.inSlot)) expect(cell.booked).toBeLessThan(2);
  });
});
