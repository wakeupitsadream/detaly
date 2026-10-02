// Processor of the `rossko` queue (decisions Б12–Б15): recheck, checkout, recover.
// Wave 3 (worker-supplier) implements it.
import type { Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { notImplemented } from '../not-implemented';

export async function processRossko(_job: Job, _deps: WorkerDeps): Promise<unknown> {
  notImplemented();
}
