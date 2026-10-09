import { describe, expect, it } from 'vitest';
import {
  bullJobId,
  HOUSEKEEPING_JOBS,
  NOTIFY_JOBS,
  OUTBOX_CHANNEL,
  OUTBOX_QUEUES,
  QUEUE_NAMES,
  RECONCILIATION_JOBS,
} from '../src/queues';

describe('bullJobId (decision Б2)', () => {
  it('replaces every ":" with "|" so BullMQ accepts PLAN-style keys', () => {
    expect(bullJobId('payment.succeeded:2f3c-11')).toBe('payment.succeeded|2f3c-11');
    expect(bullJobId('notify:0192:client_paid:sms')).toBe('notify|0192|client_paid|sms');
    expect(bullJobId('checkout:0192a')).toBe('checkout|0192a');
    expect(bullJobId('no-colons')).toBe('no-colons');
    expect(bullJobId('a:b:c:d')).not.toContain(':');
  });

  it('is injective for keys without "|"', () => {
    const keys = ['a:b', 'a|b:', 'ab', 'a::b', 'a:b:'];
    const ids = keys.filter((k) => !k.includes('|')).map(bullJobId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('queue names', () => {
  it('outbox may target every queue except dead-letter', () => {
    expect(OUTBOX_QUEUES).toEqual(QUEUE_NAMES.filter((name) => name !== 'dead-letter'));
    expect(OUTBOX_QUEUES).not.toContain('dead-letter');
  });

  it('phase 1B jobs and the outbox channel', () => {
    expect(OUTBOX_CHANNEL).toBe('detaly:outbox');
    expect(Object.keys(HOUSEKEEPING_JOBS)).toEqual([
      'heartbeat',
      'timers',
      'reminders',
      'smsBudget',
      'deferred1a',
      'retention',
      'priceCheck',
      'reviewsCheck',
      'fitChecks',
    ]);
    expect(RECONCILIATION_JOBS).toEqual({ sweep: 'sweep', nightly: 'nightly' });
  });
});

describe('step 2 jobs', () => {
  it('the weekly price check reminder', () => {
    expect(HOUSEKEEPING_JOBS.priceCheck).toBe('price-check');
  });
});

describe('step 3 jobs', () => {
  it('the weekly reviews reminder', () => {
    expect(HOUSEKEEPING_JOBS.reviewsCheck).toBe('reviews-check');
  });
});

describe('phase 1C jobs', () => {
  it('notify/vin and the daily retention', () => {
    expect(NOTIFY_JOBS).toMatchObject({ order: 'order', alert: 'alert', vin: 'vin' });
    expect(HOUSEKEEPING_JOBS.retention).toBe('retention');
  });
});

describe('step 4 jobs', () => {
  it('notify/fit (the sellers card of a fit check) and the 5-minute fit-checks run', () => {
    expect(NOTIFY_JOBS).toEqual({ order: 'order', alert: 'alert', vin: 'vin', fit: 'fit' });
    expect(HOUSEKEEPING_JOBS.fitChecks).toBe('fit-checks');
  });
});
