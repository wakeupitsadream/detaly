// Processor of the `receipts` queue (decisions Б22, Б23): the offset receipt and its polls, the
// receipt sent inside a payment. Polls are delayed outbox rows written by the jobs themselves.
import { RECEIPTS_JOBS } from '@detaly/config';
import type { Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { unknownJob } from '../unknown-job';
import { processOffsetReceipt } from './offset';
import { processPaymentReceipt } from './payment-receipt';

export async function processReceipts(job: Job, deps: WorkerDeps): Promise<unknown> {
  switch (job.name) {
    case RECEIPTS_JOBS.offset:
    case RECEIPTS_JOBS.offsetPoll:
      return processOffsetReceipt(job, deps);
    case RECEIPTS_JOBS.paymentReceipt:
      return processPaymentReceipt(job, deps);
    default:
      return unknownJob(deps, 'receipts', job.name);
  }
}
