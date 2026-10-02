import { describe, expect, it } from 'vitest';
import { parseWorkHours, type WeekSchedule } from '../src';

const h = (open: string, close: string) => {
  const min = (t: string) => {
    const [hh, mm] = t.split(':').map(Number) as [number, number];
    return hh * 60 + mm;
  };
  return { openMin: min(open), closeMin: min(close) };
};

/** Sunday-first like getUTCDay(). */
function week(
  days: Partial<Record<'вс' | 'пн' | 'вт' | 'ср' | 'чт' | 'пт' | 'сб', ReturnType<typeof h>>>,
): WeekSchedule {
  return (['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const).map((d) => days[d] ?? null);
}

const WEEKDAYS_10_19 = week({
  пн: h('10:00', '19:00'),
  вт: h('10:00', '19:00'),
  ср: h('10:00', '19:00'),
  чт: h('10:00', '19:00'),
  пт: h('10:00', '19:00'),
});

describe('parseWorkHours', () => {
  it('reads the PICKUP_HOURS of CI and the dashes people type', () => {
    expect(parseWorkHours('Пн–Пт 10:00–19:00')).toEqual(WEEKDAYS_10_19);
    expect(parseWorkHours('Пн-Пт 10:00-19:00')).toEqual(WEEKDAYS_10_19);
    expect(parseWorkHours('пн — пт: 10.00 — 19.00')).toEqual(WEEKDAYS_10_19);
    expect(parseWorkHours('Понедельник–пятница 10–19')).toEqual(WEEKDAYS_10_19);
    expect(parseWorkHours('по будням с 10 до 19')).toEqual(WEEKDAYS_10_19);
  });

  it('reads a short Saturday as a separate part', () => {
    expect(parseWorkHours('Пн-Пт 9:00-19:00, Сб 10:00-16:00')).toEqual(
      week({
        пн: h('09:00', '19:00'),
        вт: h('09:00', '19:00'),
        ср: h('09:00', '19:00'),
        чт: h('09:00', '19:00'),
        пт: h('09:00', '19:00'),
        сб: h('10:00', '16:00'),
      }),
    );
    expect(parseWorkHours('Пн-Пт 9-19;\nСб 10-16')).toEqual(
      parseWorkHours('Пн-Пт 9:00-19:00, Сб 10:00-16:00'),
    );
  });

  it('reads every day', () => {
    const daily = (['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const).map(() =>
      h('09:00', '21:00'),
    );
    expect(parseWorkHours('Ежедневно 9–21')).toEqual(daily);
    expect(parseWorkHours('Без выходных, 9:00—21:00')).toEqual(daily);
    expect(parseWorkHours('без выходных 9:00—21:00')).toEqual(daily);
    expect(parseWorkHours('Круглосуточно')).toEqual(
      (['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const).map(() => h('00:00', '24:00')),
    );
  });

  it('lends listed days to the next time and lets later parts override', () => {
    expect(parseWorkHours('Пн, Ср, Пт 9-18')).toEqual(
      week({ пн: h('09:00', '18:00'), ср: h('09:00', '18:00'), пт: h('09:00', '18:00') }),
    );
    const sundayOff = parseWorkHours('Ежедневно 9-21, Вс — выходной');
    expect(sundayOff?.[0]).toBeNull();
    expect(sundayOff?.[1]).toEqual(h('09:00', '21:00'));
    expect(parseWorkHours('Пт-Пн 10-16')).toEqual(
      week({
        пт: h('10:00', '16:00'),
        сб: h('10:00', '16:00'),
        вс: h('10:00', '16:00'),
        пн: h('10:00', '16:00'),
      }),
    );
  });

  it('gives null for anything it does not understand', () => {
    for (const text of [
      '',
      '   ',
      'по договорённости',
      'Пн-Пт',
      '10:00-19:00',
      'Пн-Пт 19:00-10:00',
      'Пн-Пт 10:00-25:00',
      'Пн-Пт 10:00-19:00 (обед 13-14)',
      'Пн-Пт 10:00-19:00, Сб',
      'Вс выходной',
      'Mon-Fri 10-19',
    ]) {
      expect(parseWorkHours(text), text).toBeNull();
    }
    expect(parseWorkHours(null)).toBeNull();
    expect(parseWorkHours(undefined)).toBeNull();
  });
});
