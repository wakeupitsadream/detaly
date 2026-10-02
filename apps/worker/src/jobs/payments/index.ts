// Processor of the `payments` queue (docs/phase-1b-implementation.md section 10): webhook,
// payment-create, payment-recheck, refund-create. Wave 3 (worker-payments) implements it.
import type { Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { notImplemented } from '../not-implemented';

export async function processPayments(_job: Job, _deps: WorkerDeps): Promise<unknown> {
  notImplemented();
}
