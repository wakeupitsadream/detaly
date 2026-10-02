/**
 * Simulated lift load for the demo and for fixtures mode (docs/design.md, section 4). No
 * Math.random: the same day and hour always give the same load, so the widget and the snapshot
 * tests are stable. Pages that show it mark the plan as demo.
 */
import { CLIENT_TIME_ZONE } from './dates';
import { isoWeekday, zonedWallTime, type HourLoad, type LoadSnapshot } from './install-window';
import type { IsoDate } from './types';
import type { WeekSchedule } from './work-hours';

export const DEMO_LIFTS = 2;

function dayOfYear(date: IsoDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
}

/**
 * Booked lifts of one local hour. Base by hour: the opening hour and from 17:00 — 2 (morning
 * drop-offs and evening pick-ups), 11:00–13:00 — 1, otherwise 0. Saturday +1. A fixed "salt"
 * `(dayOfYear * 7 + hour * 3) % 5 === 0` adds +1 so days differ. Capped by `capacity`.
 */
export function demoLoad(
  date: IsoDate,
  hour: number,
  capacity: number = DEMO_LIFTS,
  openHour = 10,
): HourLoad {
  let booked = hour <= openHour || hour >= 17 ? 2 : hour >= 11 && hour < 13 ? 1 : 0;
  if (isoWeekday(date) === 6) booked += 1;
  if ((dayOfYear(date) * 7 + hour * 3) % 5 === 0) booked += 1;
  return { booked: Math.min(booked, capacity), capacity };
}

/** demoLoad as a LoadSnapshot: the opening hour of each day comes from the schedule. */
export function demoLoadSnapshot({
  schedule,
  capacity = DEMO_LIFTS,
  timeZone = CLIENT_TIME_ZONE,
}: {
  schedule: WeekSchedule | null;
  capacity?: number;
  timeZone?: string;
}): LoadSnapshot {
  return (hourStartMs) => {
    const { date, minutes } = zonedWallTime(hourStartMs, timeZone);
    const day = schedule?.[isoWeekday(date)];
    const openHour = day ? Math.floor(day.openMin / 60) : 10;
    return demoLoad(date, Math.floor(minutes / 60), capacity, openHour);
  };
}
