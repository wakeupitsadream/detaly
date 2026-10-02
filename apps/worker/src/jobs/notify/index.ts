// Processor of the `notify` queue (section 12.1): order notifications and alerts.
// Wave 3 (worker-ops) implements it.
import type { Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { notImplemented } from '../not-implemented';

export async function processNotify(_job: Job, _deps: WorkerDeps): Promise<unknown> {
  notImplemented();
}
