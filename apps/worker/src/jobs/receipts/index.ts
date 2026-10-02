// Processor of the `receipts` queue (decisions Б22, Б23): offset receipt, its polling, receipts
// sent inside payments. Wave 3 (worker-payments) implements it.
import type { Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { notImplemented } from '../not-implemented';

export async function processReceipts(_job: Job, _deps: WorkerDeps): Promise<unknown> {
  notImplemented();
}
