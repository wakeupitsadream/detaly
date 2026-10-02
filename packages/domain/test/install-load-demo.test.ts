import { describe, expect, it } from 'vitest';
import { addDays, demoLoad, demoLoadSnapshot, parseWorkHours, planInstallWindow } from '../src';

const WEEKDAYS = parseWorkHours('Пн–Пт 10:00–19:00');

describe('demoLoad', () => {
  it('follows the base day: busy at opening and after 17, half busy at 11-13', () => {
    // 2026-10-06 is a Tuesday (day 279): the salt adds one at 14:00 only.
    const tuesday = [10, 11, 12, 13, 14, 15, 16, 17, 18].map((hour) => [
      hour,
      demoLoad('2026-10-06', hour).booked,
    ]);
    expect(tuesday).toMatchSnapshot();
  });

  it('adds one on Saturday and is capped by capacity', () => {
    expect(demoLoad('2026-10-03', 14).booked).toBeGreaterThanOrEqual(1);
    for (let hour = 0; hour < 24; hour += 1) {
      expect(demoLoad('2026-10-03', hour).booked).toBeLessThanOrEqual(2);
      expect(demoLoad('2026-10-03', hour, 3).capacity).toBe(3);
    }
  });

  it('is deterministic: two weeks of plans are the same on every run', () => {
    const load = demoLoadSnapshot({ schedule: WEEKDAYS });
    const plans = Array.from({ length: 14 }, (_, i) => {
      const etaDate = addDays('2026-10-01', i);
      const plan = planInstallWindow({
        etaDate,
        now: new Date('2026-10-01T03:00:00Z'),
        schedule: WEEKDAYS,
        load,
        loadKind: 'demo',
      });
      return [etaDate, plan?.slotStart.toISOString() ?? null];
    });
    expect(plans).toMatchSnapshot();
    // Same input, same answer.
    const again = demoLoadSnapshot({ schedule: WEEKDAYS });
    for (let h = 0; h < 48; h += 1) {
      const ms = Date.UTC(2026, 9, 5, h);
      expect(again(ms)).toEqual(load(ms));
    }
  });
});
