// Processor of the `reconciliation` queue (decision Б29, PLAN section 1): `sweep` every 10
// minutes (pending payments and refunds), `nightly` once a day (the provider's list of the day
// against the database, alerts only). Both are scheduled by worker-core.
import { RECONCILIATION_JOBS } from '@detaly/config';
import type { Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { unknownJob } from '../unknown-job';
import { runNightly } from './nightly';
import { runSweep } from './sweep';

export async function processReconciliation(job: Job, deps: WorkerDeps): Promise<unknown> {
  switch (job.name) {
    case RECONCILIATION_JOBS.sweep:
      return runSweep(deps);
    case RECONCILIATION_JOBS.nightly:
      return runNightly(deps);
    default:
      return unknownJob(deps, 'reconciliation', job.name);
  }
}
