// The next moment the pickup point is open (PICKUP_HOURS, parseWorkHours): reminders for the
// sellers that fall at night wait for the morning (docs/phase-1c-implementation.md decision С15).
import {
  addDays,
  CLIENT_TIME_ZONE,
  isoWeekday,
  parseWorkHours,
  zonedInstant,
  zonedWallTime,
} from '@detaly/domain';

/**
 * `now` when the point is open now (or PICKUP_HOURS is empty or not understood: better a
 * reminder at night than none); otherwise the next opening in the client time zone.
 */
export function nextOpeningAt(
  now: Date,
  pickupHours: string | null | undefined,
  timeZone: string = CLIENT_TIME_ZONE,
): Date {
  const week = parseWorkHours(pickupHours);
  if (week === null) return now;
  const { date, minutes } = zonedWallTime(now.getTime(), timeZone);
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = offset === 0 ? date : addDays(date, offset);
    const hours = week[isoWeekday(day)];
    if (!hours) continue;
    if (offset === 0) {
      if (minutes >= hours.openMin && minutes < hours.closeMin) return now;
      if (minutes >= hours.closeMin) continue;
    }
    return new Date(zonedInstant(day, hours.openMin, timeZone));
  }
  return now;
}
