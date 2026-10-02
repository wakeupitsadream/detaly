// Processor of the `reconciliation` queue (decision Б29): sweep every 10 minutes, nightly check.
// Wave 3 (worker-payments) implements it.
import type { Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { notImplemented } from '../not-implemented';

export async function processReconciliation(_job: Job, _deps: WorkerDeps): Promise<unknown> {
  notImplemented();
}
