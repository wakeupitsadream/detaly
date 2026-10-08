// Queue policies, schedulers and the processor wrapper (section 9.3–9.4) without Redis.
import { OUTBOX_QUEUES } from '@detaly/config';
import { RosskoRateLimitError } from '@detaly/rossko';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDeps } from '../src/deps';
import {
  jobPolicy,
  QUEUE_POLICIES,
  registerSchedulers,
  SCHEDULER_TZ,
  SCHEDULERS,
} from '../src/queues';
import { MAX_RATE_LIMIT_DELAYS, MIN_RATE_LIMIT_DELAY_MS, wrapProcessor } from '../src/workers';

describe('queue policies', () => {
  it('match section 9.3', () => {
    expect(QUEUE_POLICIES).toEqual({
      payments: { attempts: 5, backoff: { type: 'exponential', delay: 10_000 } },
      receipts: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
      rossko: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
      notify: { attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
      reconciliation: { attempts: 1 },
      housekeeping: { attempts: 1 },
    });
    expect(Object.keys(QUEUE_POLICIES).sort()).toEqual([...OUTBOX_QUEUES].sort());
  });

  it('gives GetCheckout exactly one attempt and leaves recovery to the queue policy', () => {
    expect(jobPolicy('rossko', 'checkout')).toEqual({ attempts: 1 });
    expect(jobPolicy('rossko', 'recover')).toEqual(QUEUE_POLICIES.rossko);
    expect(jobPolicy('rossko', 'recheck')).toEqual(QUEUE_POLICIES.rossko);
    expect(jobPolicy('notify', 'checkout')).toEqual(QUEUE_POLICIES.notify);
  });
});

describe('schedulers', () => {
  it('cover section 9.4', () => {
    expect(SCHEDULERS.map((s) => [s.queue, s.name, s.repeat])).toEqual([
      ['housekeeping', 'heartbeat', { every: 30_000 }],
      ['housekeeping', 'timers', { every: 60_000 }],
      ['housekeeping', 'reminders', { every: 900_000 }],
      ['housekeeping', 'sms-budget', { every: 3_600_000 }],
      ['housekeeping', 'deferred-1a', { every: 600_000 }],
      ['housekeeping', 'retention', { pattern: '40 4 * * *', tz: 'Asia/Yekaterinburg' }],
      // step 2: «Пора сверить цены», Mondays at 10:00 local
      ['housekeeping', 'price-check', { pattern: '0 10 * * 1', tz: 'Asia/Yekaterinburg' }],
      // step 3: «Отзывы: обновите рейтинг…», Mondays at 10:05 local
      ['housekeeping', 'reviews-check', { pattern: '5 10 * * 1', tz: 'Asia/Yekaterinburg' }],
      ['reconciliation', 'sweep', { every: 600_000 }],
      ['reconciliation', 'nightly', { pattern: '15 3 * * *', tz: 'Asia/Yekaterinburg' }],
    ]);
    expect(SCHEDULER_TZ).toBe('Asia/Yekaterinburg');
  });

  it('registers housekeeping only when the reconciliation queue is not passed', async () => {
    const housekeeping = vi.fn(async () => ({}));
    await registerSchedulers({ housekeeping: { upsertJobScheduler: housekeeping } as never });
    // heartbeat, timers, reminders, sms-budget, deferred-1a, the phase 1C retention, the
    // step 2 price check and the step 3 reviews check
    expect(housekeeping).toHaveBeenCalledTimes(8);

    const reconciliation = vi.fn(async () => ({}));
    await registerSchedulers({
      housekeeping: { upsertJobScheduler: housekeeping } as never,
      reconciliation: { upsertJobScheduler: reconciliation } as never,
    });
    expect(reconciliation).toHaveBeenCalledWith(
      'nightly',
      { pattern: '15 3 * * *', tz: 'Asia/Yekaterinburg' },
      expect.objectContaining({ name: 'nightly', opts: expect.objectContaining({ attempts: 1 }) }),
    );
  });
});

describe('wrapProcessor', () => {
  const deps = {} as WorkerDeps;

  function fakeJob(attemptsStarted = 1) {
    const moveToDelayed = vi.fn(async (_at: number, _token?: string) => undefined);
    return { job: { attemptsStarted, moveToDelayed } as unknown as Job, moveToDelayed };
  }

  it('passes the result through', async () => {
    const { job } = fakeJob();
    await expect(wrapProcessor(async () => 42, deps)(job, 'tok')).resolves.toBe(42);
  });

  it('delays a rate-limited job by retryAfterMs (at least 1 s) without failing it', async () => {
    const { job, moveToDelayed } = fakeJob();
    const before = Date.now();
    const error = await wrapProcessor(async () => {
      throw new RosskoRateLimitError(5_000);
    }, deps)(job, 'tok').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DelayedError);
    const [at, token] = moveToDelayed.mock.calls[0] ?? [];
    expect(token).toBe('tok');
    expect(at).toBeGreaterThanOrEqual(before + 5_000);

    const short = fakeJob();
    await wrapProcessor(async () => {
      throw new RosskoRateLimitError(0);
    }, deps)(short.job, 'tok').catch(() => undefined);
    expect(short.moveToDelayed.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(
      before + MIN_RATE_LIMIT_DELAY_MS,
    );
  });

  it('stops delaying after MAX_RATE_LIMIT_DELAYS starts', async () => {
    const { job, moveToDelayed } = fakeJob(MAX_RATE_LIMIT_DELAYS + 1);
    const error = await wrapProcessor(async () => {
      throw new RosskoRateLimitError(1_000);
    }, deps)(job, 'tok').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RosskoRateLimitError);
    expect(moveToDelayed).not.toHaveBeenCalled();
  });

  it('turns UnrecoverableSmsError into UnrecoverableError and passes other errors on', async () => {
    const { job } = fakeJob();
    const sms = new Error('smsaero: sms rejected (invalid_number)');
    sms.name = 'UnrecoverableSmsError';
    const mapped = await wrapProcessor(async () => {
      throw sms;
    }, deps)(job, 'tok').catch((e: unknown) => e);
    expect(mapped).toBeInstanceOf(UnrecoverableError);
    expect((mapped as Error).message).toBe(sms.message);

    const plain = new Error('boom');
    await expect(
      wrapProcessor(async () => {
        throw plain;
      }, deps)(job, 'tok'),
    ).rejects.toBe(plain);
  });
});
