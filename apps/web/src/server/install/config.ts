/**
 * Install window parameters (docs/design.md, section 4). One place to change them.
 */
import { CLIENT_TIME_ZONE, type InstallWindowOptions } from '@detaly/domain';

/** Lifts the partner service can give to our clients at the same time. VERIFY with Лёша. */
export const INSTALL_LIFTS = 2;

/** A typical replacement job, minutes (filter, pads, plugs). VERIFY with Лёша. */
export const INSTALL_JOB_MIN = 120;

export const INSTALL_TIME_ZONE = CLIENT_TIME_ZONE;

/** Passed to planInstallWindow. */
export const INSTALL_WINDOW_OPTIONS: Partial<InstallWindowOptions> = {
  arrivalTime: '12:00',
  leadMin: 60,
  jobMin: INSTALL_JOB_MIN,
  stepMin: 60,
  horizonDays: 14,
};

/** Bookings that hold a lift (requested ones too: the master has not said no yet). */
export const HOLDING_BOOKING_STATUSES = ['requested', 'confirmed'] as const;
