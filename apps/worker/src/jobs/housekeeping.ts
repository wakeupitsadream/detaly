// Processor of the `housekeeping` queue. Phase 0 knows a single job: the heartbeat.
import { HEARTBEAT_KEY, HOUSEKEEPING_JOBS, writeHeartbeat, type Redis } from '@detaly/config';
import { UnrecoverableError, type Job } from 'bullmq';

export interface HousekeepingDeps {
  redis: Redis;
  /** Clock (tests). */
  now?: () => Date;
  /** Heartbeat key; default HEARTBEAT_KEY (tests use a `test:<uuid>:` key). */
  heartbeatKey?: string;
}

export type HousekeepingResult = { heartbeatAt: number };

/**
 * `heartbeat`: SET <key> <epoch ms> EX 600 via writeHeartbeat. /api/health, the compose
 * healthcheck and healthwatch.sh read this key to tell a live worker from a silent one.
 */
export async function processHousekeeping(
  job: Pick<Job, 'name'>,
  { redis, now = () => new Date(), heartbeatKey = HEARTBEAT_KEY }: HousekeepingDeps,
): Promise<HousekeepingResult> {
  switch (job.name) {
    case HOUSEKEEPING_JOBS.heartbeat: {
      const at = now();
      await writeHeartbeat(redis, { now: at, key: heartbeatKey });
      return { heartbeatAt: at.getTime() };
    }
    default:
      throw new UnrecoverableError(`unknown housekeeping job: ${job.name}`);
  }
}
