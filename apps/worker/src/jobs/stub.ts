// Placeholder processor for queues whose jobs arrive in phase 1 (payments, receipts, rossko,
// notify, reconciliation). A job that shows up early fails at once instead of being retried.
import { UnrecoverableError, type Job } from 'bullmq';

export const STUB_ERROR_MESSAGE = 'phase 0';

export async function processStub(_job: Pick<Job, 'name'>): Promise<never> {
  throw new UnrecoverableError(STUB_ERROR_MESSAGE);
}
