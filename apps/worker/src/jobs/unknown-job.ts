// Shared failure for a job name a queue does not know: it fails at once (UnrecoverableError, no
// retries) and lands in dead-letter instead of being retried.
import type { WorkerDeps } from '../deps';
import { UnrecoverableError } from 'bullmq';

export function unknownJobMessage(queue: string, name: string): string {
  return `unknown ${queue} job: ${name}`;
}

/** Logs the unknown name (when a logger is at hand) and throws UnrecoverableError. */
export function unknownJob(
  deps: Pick<WorkerDeps, 'logger'> | undefined,
  queue: string,
  name: string,
): never {
  deps?.logger?.error({ queue, job: name }, 'unknown job name');
  throw new UnrecoverableError(unknownJobMessage(queue, name));
}
