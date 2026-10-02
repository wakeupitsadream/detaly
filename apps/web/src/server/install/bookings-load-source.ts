/**
 * Live lift load from install_bookings: one query for the whole interval, then an in-memory
 * count per hour. A booking holds one lift for `jobMin` from its slot.
 */
import { and, gt, inArray, installBookings, lt, type Executor } from '@detaly/db';
import type { LoadSnapshot } from '@detaly/domain';
import { HOLDING_BOOKING_STATUSES } from './config';
import type { LoadSource } from './load-source';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Load per hour from booking start times (epoch ms). */
export function snapshotFromBookings(
  slotStarts: readonly number[],
  capacity: number,
  jobMin: number,
): LoadSnapshot {
  const jobMs = jobMin * MINUTE_MS;
  return (hourStartMs) => {
    const hourEnd = hourStartMs + HOUR_MS;
    let booked = 0;
    for (const start of slotStarts) {
      if (start < hourEnd && start + jobMs > hourStartMs) booked += 1;
    }
    return { booked, capacity };
  };
}

export function createBookingsLoadSource({
  db,
  capacity,
  jobMin,
}: {
  db: Executor;
  capacity: number;
  jobMin: number;
}): LoadSource {
  return {
    kind: 'live',
    async snapshot(from, to) {
      const rows = await db
        .select({ slotAt: installBookings.slotAt })
        .from(installBookings)
        .where(
          and(
            // A booking that started less than jobMin before `from` still holds a lift.
            gt(installBookings.slotAt, new Date(from.getTime() - jobMin * MINUTE_MS)),
            lt(installBookings.slotAt, to),
            inArray(installBookings.status, [...HOLDING_BOOKING_STATUSES]),
          ),
        );
      return snapshotFromBookings(
        rows.map((row) => row.slotAt.getTime()),
        capacity,
        jobMin,
      );
    },
  };
}
