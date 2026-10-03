/**
 * Live lift load from install_bookings. The query and the count per hour live in one place,
 * `loadInstallLoad` of @detaly/orders (docs/phase-1c-implementation.md decision С6): the
 * booking check under the advisory lock and the pages read the same load, so the slot a page
 * offers is the one bookInstall accepts.
 */
import type { Executor } from '@detaly/db';
import { loadInstallLoad, snapshotFromBookings } from '@detaly/orders';
import type { LoadSource } from './load-source';

/** Load per hour from booking start times (epoch ms); re-exported for the planner tests. */
export { snapshotFromBookings };

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
    snapshot: (from, to) => loadInstallLoad(db, { from, to, capacity, jobMin }),
  };
}
