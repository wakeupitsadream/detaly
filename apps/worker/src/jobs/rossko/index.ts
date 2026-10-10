// Processor of the `rossko` queue (decisions Б12–Б15, docs/phase-1b-implementation.md
// section 11): recheck before ordering, GetCheckout with double-submit protection, recovery
// after an ambiguous GetCheckout failure; step 8 (docs/rossko-automation.md): the GetOrders
// polling of a Job Scheduler, off unless ROSSKO_MODE=live and settings rossko.poll_enabled.
import { ROSSKO_JOBS } from '@detaly/config';
import type { Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { unknownJob } from '../unknown-job';
import { processCheckout, processRecover } from './checkout';
import { processPollOrders } from './poll-orders';
import { processRecheck } from './recheck';

export { processCheckout, processRecover, UNMATCHED_ITEM_ERROR } from './checkout';
export type { CheckoutFailureReason, CheckoutJobResult, SettleResult } from './checkout';
export {
  POLL_ORDERS_LIMIT,
  POLL_VIA,
  processPollOrders,
  rosskoOrderCode,
  type PollOrdersResult,
} from './poll-orders';
export { processRecheck, RECHECK_UNAVAILABLE_NOTE, SupplierSearchError } from './recheck';
export type { RecheckJobResult } from './recheck';
export {
  CRITICAL_LIMITER_WAIT_MS,
  RECOVER_DELAY_MS,
  isFinalAttempt,
  recoverDelayMs,
} from './shared';

export async function processRossko(job: Job, deps: WorkerDeps): Promise<unknown> {
  switch (job.name) {
    case ROSSKO_JOBS.recheck:
      return processRecheck(job, deps);
    case ROSSKO_JOBS.checkout:
      return processCheckout(job, deps);
    case ROSSKO_JOBS.recover:
      return processRecover(job, deps);
    case ROSSKO_JOBS.pollOrders:
      return processPollOrders(job, deps);
    default:
      return unknownJob(deps, 'rossko', job.name);
  }
}
