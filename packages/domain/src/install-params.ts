/**
 * Install window numbers (docs/design.md section 4, docs/phase-1c-implementation.md decision
 * С22). No imports: the storefront texts (apps/web/src/lib/install-params.ts re-exports these
 * numbers next to their wording), the web planner and the worker's client bot read the same
 * values through the `@detaly/domain/install-params` subpath.
 */

/** Lifts the partner service can give to our clients at the same time. VERIFY with Лёша. */
export const INSTALL_LIFTS = 2;

/** A typical replacement job, minutes (filter, pads, plugs). VERIFY with Лёша. */
export const INSTALL_JOB_MIN = 120;

/** Supplier deliveries reach the service by this time of the pickup day. VERIFY with Лёша. */
export const INSTALL_ARRIVAL_TIME = '12:00';

/** A part already at the point can go on the lift no sooner than this, minutes. */
export const INSTALL_LEAD_MIN = 60;

/** Slot starts are tried with this step, minutes. */
export const INSTALL_STEP_MIN = 60;

/** How far ahead the planner looks, days. */
export const INSTALL_HORIZON_DAYS = 14;

/** How many free slots the order page and the client bot offer (decision С6). */
export const INSTALL_SLOTS_SHOWN = 6;

/** The client cancels a booking by themselves no later than this before the slot, minutes. */
export const INSTALL_CLIENT_CANCEL_BEFORE_MIN = 120;
