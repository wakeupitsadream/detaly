// Processor of the `housekeeping` queue. Phase 0 knows a single job: the heartbeat; phase 1B
// (worker-ops) adds timers, reminders, the SMS budget and deferred 1A effects.
import { HOUSEKEEPING_JOBS, writeHeartbeat } from '@detaly/config';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../deps';

/** What the heartbeat needs from WorkerDeps (a full WorkerDeps satisfies it). */
export type HousekeepingDeps = Pick<WorkerDeps, 'redis' | 'now' | 'heartbeatKey'>;

export type HousekeepingResult = { heartbeatAt: number };

/**
 * `heartbeat`: SET <deps.heartbeatKey> <epoch ms> EX 600 via writeHeartbeat. /api/health, the
 * compose healthcheck and healthwatch.sh read this key to tell a live worker from a silent one.
 */
export async function processHousekeeping(
  job: Pick<Job, 'name'>,
  deps: HousekeepingDeps,
): Promise<HousekeepingResult> {
  switch (job.name) {
    case HOUSEKEEPING_JOBS.heartbeat: {
      const at = deps.now();
      await writeHeartbeat(deps.redis, { now: at, key: deps.heartbeatKey });
      return { heartbeatAt: at.getTime() };
    }
    default:
      throw new UnrecoverableError(`unknown housekeeping job: ${job.name}`);
  }
}
