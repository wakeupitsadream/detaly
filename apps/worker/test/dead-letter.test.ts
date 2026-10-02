// Dead-letter helpers without Redis: final-failure detection, ids and PD-free error text.
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import {
  deadLetterAlertText,
  deadLetterJobId,
  isFinalFailure,
  isSchedulerJob,
  moveToDeadLetter,
  redactText,
  safeErrorMessage,
  SAFE_ERROR_MAX,
} from '../src/dead-letter';
import { createQueueInspector } from '../src/inspector';
import { rejectBackoffSeconds } from '../src/outbox/dispatcher';
import type { Queues } from '../src/queues';

describe('isFinalFailure', () => {
  const job = (attemptsMade: number, attempts?: number, finishedOn?: number) =>
    ({ attemptsMade, opts: { attempts }, finishedOn }) as Pick<
      Job,
      'attemptsMade' | 'opts' | 'finishedOn'
    >;

  it('is final for UnrecoverableError, a finished job or exhausted attempts', () => {
    expect(isFinalFailure(job(1, 5), new UnrecoverableError('x'))).toBe(true);
    expect(isFinalFailure(job(1, 5, Date.now()), new Error('x'))).toBe(true);
    expect(isFinalFailure(job(5, 5), new Error('x'))).toBe(true);
    expect(isFinalFailure(job(1), new Error('x'))).toBe(true);
  });

  it('is not final while attempts remain', () => {
    expect(isFinalFailure(job(1, 5), new Error('x'))).toBe(false);
    expect(isFinalFailure(job(4, 5), new Error('x'))).toBe(false);
  });
});

describe('deadLetterJobId', () => {
  const at = new Date('2026-10-02T09:41:00Z');

  it('is `${queue}|${job.id}` for regular jobs, free of ":"', () => {
    expect(deadLetterJobId('notify', { id: 'notify|e1|arrived', name: 'order' }, at)).toBe(
      'notify|notify|e1|arrived',
    );
    expect(deadLetterJobId('payments', { id: 'a:b:c', name: 'webhook' }, at)).toBe(
      'payments|a|b|c',
    );
  });

  it('buckets Job Scheduler runs by name and hour', () => {
    const run = { id: 'repeat:timers:1790000000000', name: 'timers', repeatJobKey: 'timers' };
    expect(isSchedulerJob(run)).toBe(true);
    expect(deadLetterJobId('housekeeping', run, at)).toBe('housekeeping|timers|2026-10-02T09');
    expect(isSchedulerJob({ id: 'notify|x', repeatJobKey: undefined })).toBe(false);
  });
});

describe('safeErrorMessage', () => {
  it('masks phones, bot tokens and opaque tokens, keeps uuids and identifiers', () => {
    const uuid = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
    const text = safeErrorMessage(
      new Error(
        `order ${uuid} for +7 (912) 345-67-89 / 89123456789 via bot123456:AAH-abcdefghijklmnopqrstuvwxyz012345 ` +
          `token Zx9_aB3dE5fG7hJ9kL1mN3pQ`,
      ),
    );
    expect(text).toContain(uuid);
    expect(text).not.toMatch(/912|345-67|abcdefghij|Zx9_aB3/);
    expect(text).toContain('[phone]');
    expect(text).toContain('[token]');
    expect(text).toContain('[redacted]');
    expect(safeErrorMessage(new TypeError('RosskoRateLimitError not_implemented'))).toBe(
      'TypeError: RosskoRateLimitError not_implemented',
    );
  });

  it('keeps long identifiers readable but masks random tokens and order links', () => {
    expect(redactText('CheckoutDisabledError: ROSSKO_ALLOW_CHECKOUT is false')).toBe(
      'CheckoutDisabledError: ROSSKO_ALLOW_CHECKOUT is false',
    );
    expect(redactText('violates orders_supplier_order_sending_unique')).toBe(
      'violates orders_supplier_order_sending_unique',
    );
    // Letters only, but random: a 128-bit token may well look like this.
    expect(redactText('token QWErtyUIOPasdfGHJKLzxcvb')).toBe('token [redacted]');
    expect(redactText('GET https://shop.example/o/abc-DEF_123 failed')).toBe(
      'GET https://shop.example/o/[token] failed',
    );
  });

  it('is linear on long words (no catastrophic backtracking)', () => {
    const started = Date.now();
    redactText(`${'a'.repeat(5000)}!`, 10_000);
    redactText(`${'Ab'.repeat(5000)}1`, 10_000);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('caps the length and accepts non-errors', () => {
    expect(redactText('я'.repeat(1000))).toHaveLength(SAFE_ERROR_MAX);
    expect(safeErrorMessage('plain')).toBe('plain');
  });
});

describe('moveToDeadLetter', () => {
  it('never throws: a failed add is logged and no alert is sent', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const alerts = { send: vi.fn(async () => undefined) };
    const id = await moveToDeadLetter(
      {
        deadLetter: {
          add: vi.fn(async () => {
            throw new Error('Connection is closed');
          }),
        },
        alerts,
        logger,
      },
      'notify',
      { id: 'j1', name: 'order', data: {}, attemptsMade: 5 } as unknown as Job,
      new Error('x'),
    );
    expect(id).toBeNull();
    expect(alerts.send).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('survives an alert failure', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const add = vi.fn(async (..._args: unknown[]) => ({}) as Job);
    const id = await moveToDeadLetter(
      {
        deadLetter: { add },
        alerts: {
          send: async () => {
            throw new Error('telegram down');
          },
        },
        logger,
        now: () => new Date('2026-10-02T09:00:00Z'),
      },
      'receipts',
      { id: 'r1', name: 'offset', data: { receiptId: 'x' }, attemptsMade: 3 } as unknown as Job,
      new Error('boom'),
    );
    expect(id).toBe('receipts|r1');
    expect(add).toHaveBeenCalledWith(
      'dead',
      {
        queue: 'receipts',
        name: 'offset',
        jobId: 'r1',
        data: { receiptId: 'x' },
        error: 'boom',
        failedAt: '2026-10-02T09:00:00.000Z',
        attemptsMade: 3,
      },
      { jobId: 'receipts|r1' },
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ deadLetterId: 'receipts|r1' }),
      'dead-letter alert failed',
    );
  });

  it('alert text is Russian and names the queue, the job and /queues', () => {
    expect(
      deadLetterAlertText({
        queue: 'payments',
        name: 'webhook',
        jobId: 'x',
        data: {},
        error: 'boom',
        failedAt: '',
        attemptsMade: 5,
      }),
    ).toBe(
      'Задача не выполнена: payments / webhook\nПопыток: 5\nОшибка: boom\nПовторить — /queues',
    );
  });
});

describe('outbox reject backoff', () => {
  it('doubles from 2 s and stops at 5 min', () => {
    expect([1, 2, 3, 8, 9, 10, 50].map(rejectBackoffSeconds)).toEqual([
      2, 4, 8, 256, 300, 300, 300,
    ]);
    expect(rejectBackoffSeconds(0)).toBe(2);
  });
});

describe('retryDeadLetter (fake queues)', () => {
  function fakeQueues(entry: Record<string, unknown> | null, addFails = false) {
    const calls: string[] = [];
    const parked = entry && {
      name: 'dead',
      data: entry,
      remove: vi.fn(async () => {
        calls.push('dead.remove');
      }),
    };
    const queues = {
      'dead-letter': {
        getJob: vi.fn(async () => parked ?? undefined),
        add: vi.fn(async (_name: string, _data: unknown, opts: { jobId: string }) => {
          calls.push(`dead.add:${opts.jobId}`);
        }),
      },
      housekeeping: {
        getJob: vi.fn(async () => undefined),
        add: vi.fn(async (_name: string, _data: unknown, opts: { jobId?: string }) => {
          calls.push(`housekeeping.add:${opts.jobId}`);
          if (addFails) throw new Error('Connection is closed');
        }),
      },
    } as unknown as Queues;
    return { queues, calls };
  }

  const schedulerEntry = {
    queue: 'housekeeping',
    name: 'timers',
    jobId: null,
    data: {},
    error: 'x',
    failedAt: '2026-10-02T09:00:00.000Z',
    attemptsMade: 1,
  };
  const deadId = 'housekeeping|timers|2026-10-02T09';

  it('removes the entry before re-adding; a scheduler run gets an id derived from it', async () => {
    const { queues, calls } = fakeQueues(schedulerEntry);
    expect(await createQueueInspector({ queues }).retryDeadLetter(deadId)).toBe(true);
    expect(calls).toEqual(['dead.remove', `housekeeping.add:${deadId}|retry`]);
  });

  it('puts the entry back when the add fails', async () => {
    const { queues, calls } = fakeQueues(schedulerEntry, true);
    await expect(createQueueInspector({ queues }).retryDeadLetter(deadId)).rejects.toThrow(
      'Connection is closed',
    );
    expect(calls).toEqual([
      'dead.remove',
      `housekeeping.add:${deadId}|retry`,
      `dead.add:${deadId}`,
    ]);
  });
});
