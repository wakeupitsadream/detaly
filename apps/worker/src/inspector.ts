// QueueInspector for /queues in the seller bot (decision Б30): job counts per queue, the latest
// dead-letter entries and «Повторить», which puts a parked job back into its queue.
import { bullJobId, QUEUE, QUEUE_NAMES, type Logger } from '@detaly/config';
import type { Job } from 'bullmq';
import { isOutboxQueue, type DeadLetterData } from './dead-letter';
import type { DeadLetterView, QueueInspector, QueueStats } from './deps';
import { jobPolicy, type Queues } from './queues';

/** States a dead-letter entry can be in (the queue has no Worker, so normally `waiting`). */
const PARKED_STATES = ['waiting', 'delayed', 'prioritized'] as const;

/** States in which the original job still runs or will run: nothing to put back. */
const LIVE_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

function toView(job: Job): DeadLetterView | null {
  const data = job.data as Partial<DeadLetterData> | undefined;
  if (!job.id || !data) return null;
  return {
    id: job.id,
    queue: String(data.queue ?? ''),
    name: String(data.name ?? job.name),
    jobId: typeof data.jobId === 'string' ? data.jobId : null,
    error: String(data.error ?? ''),
    failedAt: String(data.failedAt ?? new Date(job.timestamp).toISOString()),
  };
}

export interface CreateQueueInspectorOptions {
  queues: Queues;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

export function createQueueInspector({
  queues,
  logger,
}: CreateQueueInspectorOptions): QueueInspector {
  const deadLetter = queues[QUEUE.deadLetter];

  return {
    async stats(): Promise<QueueStats[]> {
      return Promise.all(
        QUEUE_NAMES.map(async (name) => {
          const counts = await queues[name].getJobCounts(
            'waiting',
            'prioritized',
            'active',
            'delayed',
            'failed',
            'completed',
          );
          return {
            queue: name,
            waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
            completed: counts.completed ?? 0,
          };
        }),
      );
    },

    async deadLetters(limit: number): Promise<DeadLetterView[]> {
      if (limit <= 0) return [];
      // Newest first.
      const jobs = await deadLetter.getJobs([...PARKED_STATES], 0, limit - 1, false);
      return jobs
        .map(toView)
        .filter((view): view is DeadLetterView => view !== null)
        .slice(0, limit);
    },

    async retryDeadLetter(id: string): Promise<boolean> {
      const parked = await deadLetter.getJob(id);
      if (!parked) return false;
      const entry = parked.data as Partial<DeadLetterData>;
      if (!isOutboxQueue(entry.queue) || typeof entry.name !== 'string') return false;
      const target = queues[entry.queue];
      const data = entry.data ?? {};
      // Scheduler runs have generated ids: the retry gets one derived from the entry, so a
      // double «Повторить» still adds a single job.
      const jobId = typeof entry.jobId === 'string' ? entry.jobId : bullJobId(`${id}|retry`);

      // The entry goes first: a job that fails again at once parks under the same id, which
      // would be a no-op while the old entry is still there (and the old entry would then be
      // removed, losing the new failure). A second call then finds no entry.
      try {
        await parked.remove();
      } catch {
        return false;
      }
      try {
        const original = await target.getJob(jobId);
        if (original) {
          const state = await original.getState();
          if (!LIVE_STATES.has(state)) {
            // A failed (or completed) job with the same id would make add() a no-op.
            await original.remove();
          }
        }
        // add() with the id of a job that still waits or runs returns that job: no duplicate.
        await target.add(entry.name, data, { ...jobPolicy(entry.queue, entry.name), jobId });
      } catch (error) {
        // Put the entry back so the owner can retry later; the add error goes to the caller.
        await deadLetter.add(parked.name, parked.data, { jobId: id }).catch(() => undefined);
        throw error;
      }
      logger?.info(
        { deadLetterId: id, queue: entry.queue, jobName: entry.name },
        'dead-letter retried',
      );
      return true;
    },
  };
}
