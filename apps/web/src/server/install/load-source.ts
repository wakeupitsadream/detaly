/**
 * Where the lift load comes from: `demo` (simulated, the UI says so) in DEMO_MODE and in
 * fixtures mode, `live` from install_bookings otherwise. To change the live source, change
 * only createLiveLoadSource below.
 */
import type { LoadSnapshot, WeekSchedule } from '@detaly/domain';
import { getBrand } from '../brand';
import { getDb } from '../db';
import { isDemoMode } from '../mode';
import { createBookingsLoadSource } from './bookings-load-source';
import { INSTALL_JOB_MIN, INSTALL_LIFTS, INSTALL_TIME_ZONE } from './config';
import { createDemoLoadSource } from './demo-load-source';

export interface LoadSource {
  readonly kind: 'demo' | 'live';
  /** Load of every hour in [from, to); one call per page. */
  snapshot(from: Date, to: Date): Promise<LoadSnapshot>;
}

function createLiveLoadSource(): LoadSource {
  return createBookingsLoadSource({
    db: getDb(),
    capacity: INSTALL_LIFTS,
    jobMin: INSTALL_JOB_MIN,
  });
}

/** The source for this process: demo when there are no real bookings to read, live otherwise. */
export function getLoadSource(schedule: WeekSchedule | null): LoadSource {
  if (isDemoMode() || getBrand().demoData) {
    return createDemoLoadSource({
      schedule,
      capacity: INSTALL_LIFTS,
      timeZone: INSTALL_TIME_ZONE,
    });
  }
  return createLiveLoadSource();
}
