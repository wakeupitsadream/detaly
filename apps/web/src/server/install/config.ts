/**
 * Install window parameters (docs/design.md, section 4). The numbers live in
 * lib/install-params.ts, next to their wording, so the page texts never drift from the planner.
 */
import {
  CLIENT_TIME_ZONE,
  INSTALL_HOLDING_STATUSES,
  type InstallWindowOptions,
} from '@detaly/domain';
import {
  INSTALL_ARRIVAL_TIME,
  INSTALL_HORIZON_DAYS,
  INSTALL_JOB_MIN,
  INSTALL_LEAD_MIN,
  INSTALL_STEP_MIN,
} from '@/lib/install-params';

export { INSTALL_JOB_MIN, INSTALL_LIFTS } from '@/lib/install-params';

export const INSTALL_TIME_ZONE = CLIENT_TIME_ZONE;

/** Passed to planInstallWindow. */
export const INSTALL_WINDOW_OPTIONS: Partial<InstallWindowOptions> = {
  arrivalTime: INSTALL_ARRIVAL_TIME,
  leadMin: INSTALL_LEAD_MIN,
  jobMin: INSTALL_JOB_MIN,
  stepMin: INSTALL_STEP_MIN,
  horizonDays: INSTALL_HORIZON_DAYS,
};

/** Bookings that hold a lift (requested ones too: the master has not said no yet). */
export const HOLDING_BOOKING_STATUSES = INSTALL_HOLDING_STATUSES;
