// Processor of the `housekeeping` queue (docs/phase-1b-implementation.md section 12.2):
// heartbeat (phase 0), timers (every minute), reminders (15 min), sms-budget (hourly) and
// deferred-1a (10 min). One attempt each: the next scheduled run picks up what one missed.
import { HOUSEKEEPING_JOBS, writeHeartbeat } from '@detaly/config';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../deps';
import { runDeferred1a, type Deferred1aResult } from './housekeeping/deferred-1a';
import { runReminders, type RemindersResult } from './housekeeping/reminders';
import { runSmsBudget, type SmsBudgetResult } from './housekeeping/sms-budget';
import { runTimers, type TimersResult } from './housekeeping/timers';

export { planDeferred, runDeferred1a } from './housekeeping/deferred-1a';
export { runReminders } from './housekeeping/reminders';
export { runSmsBudget } from './housekeeping/sms-budget';
export { runTimers } from './housekeeping/timers';

/**
 * What the heartbeat needs from WorkerDeps (a full WorkerDeps satisfies it). The phase 0
 * composition in workers.ts passes only these; every other job needs the full WorkerDeps.
 */
export type HousekeepingDeps = Pick<WorkerDeps, 'redis' | 'now' | 'heartbeatKey'>;

export type HousekeepingResult =
  { heartbeatAt: number } | TimersResult | RemindersResult | SmsBudgetResult | Deferred1aResult;

const FULL_DEPS_JOBS: readonly string[] = [
  HOUSEKEEPING_JOBS.timers,
  HOUSEKEEPING_JOBS.reminders,
  HOUSEKEEPING_JOBS.smsBudget,
  HOUSEKEEPING_JOBS.deferred1a,
];

function fullDeps(job: Pick<Job, 'name'>, deps: HousekeepingDeps | WorkerDeps): WorkerDeps {
  if (!('db' in deps) || !('engine' in deps)) {
    throw new UnrecoverableError(`housekeeping ${job.name} needs WorkerDeps`);
  }
  return deps;
}

/**
 * `heartbeat`: SET <deps.heartbeatKey> <epoch ms> EX 600 via writeHeartbeat. /api/health, the
 * compose healthcheck and healthwatch.sh read this key to tell a live worker from a silent one.
 */
export async function processHousekeeping(
  job: Pick<Job, 'name'>,
  deps: HousekeepingDeps | WorkerDeps,
): Promise<HousekeepingResult> {
  if (job.name === HOUSEKEEPING_JOBS.heartbeat) {
    const at = deps.now();
    await writeHeartbeat(deps.redis, { now: at, key: deps.heartbeatKey });
    return { heartbeatAt: at.getTime() };
  }
  if (!FULL_DEPS_JOBS.includes(job.name)) {
    throw new UnrecoverableError(`unknown housekeeping job: ${job.name}`);
  }
  const full = fullDeps(job, deps);
  const started = Date.now();
  let result: HousekeepingResult;
  switch (job.name) {
    case HOUSEKEEPING_JOBS.timers:
      result = await runTimers(full);
      break;
    case HOUSEKEEPING_JOBS.reminders:
      result = await runReminders(full);
      break;
    case HOUSEKEEPING_JOBS.smsBudget:
      result = await runSmsBudget(full);
      break;
    default:
      result = await runDeferred1a(full);
      break;
  }
  full.logger.debug(
    { job: job.name, ms: Date.now() - started, result },
    'housekeeping job finished',
  );
  return result;
}
