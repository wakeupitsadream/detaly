// housekeeping/price-check (step 2, docs/pricing.md): «Пора сверить цены» to the sellers chat on
// Mondays unless the last 7 days already have 20 comparisons. Its own database
// (`${workerDatabaseUrl}_ops_pc`): the job counts every price_benchmarks row of the database.
import { createDb, eq, outbox, priceBenchmarks, type Db } from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { processHousekeeping } from '../src/jobs/housekeeping';
import {
  PRICE_CHECK_TARGET,
  priceCheckText,
  type PriceCheckResult,
} from '../src/jobs/housekeeping/price-check';
import { processNotify } from '../src/jobs/notify';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const DAY = 86_400_000;
// Monday 12 October 2026, 10:00 in Orenburg.
const MONDAY = new Date('2026-10-12T05:00:00.000Z');
const clock = { now: new Date(MONDAY) };

function job(name: string, data: Record<string, unknown> = {}): Job {
  return { name, data, attemptsMade: 0, opts: { attempts: 1 } } as unknown as Job;
}

describe.skipIf(!inject('workerDatabaseUrl'))('housekeeping price-check', () => {
  let t: TestDeps;
  let db: Db;
  const run = () =>
    processHousekeeping({ name: 'price-check' }, t.deps) as Promise<PriceCheckResult>;

  async function addComparisons(count: number, capturedAt: Date): Promise<void> {
    await db.insert(priceBenchmarks).values(
      Array.from({ length: count }, (_, i) => ({
        brand: 'Knecht',
        article: `OC${90 + i}`,
        priceGroup: 'filters',
        competitor: 'emex',
        competitorPriceKop: 60_000,
        capturedAt,
        capturedBy: 'admin',
      })),
    );
  }

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${inject('workerDatabaseUrl')}_ops_pc` });
    db = createDb(url, { max: 4 });
    t = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: { APP_BASE_URL: 'https://detaly.test' },
    });
  });
  afterAll(async () => {
    await t?.close();
    await db?.close();
  });
  beforeEach(async () => {
    await db.delete(priceBenchmarks);
    await db.delete(outbox);
    clock.now = new Date(MONDAY);
  });

  it('reminds the sellers chat once per day when the week has fewer than 20 records', async () => {
    // 5 this week, 30 more than 7 days ago (they do not count)
    await addComparisons(5, new Date(MONDAY.getTime() - 2 * DAY));
    await addComparisons(30, new Date(MONDAY.getTime() - 8 * DAY));

    expect(await run()).toEqual({ lastWeek: 5, alerted: 'alert:price-check:2026-10-12' });
    expect(await run()).toEqual({ lastWeek: 5, alerted: null });

    const rows = await db
      .select()
      .from(outbox)
      .where(eq(outbox.jobId, 'alert:price-check:2026-10-12'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ queue: 'notify', name: 'alert' });
    expect(rows[0]?.data).toEqual({
      audience: 'sellers',
      dedupeKey: 'price-check:2026-10-12',
      text: 'Пора сверить цены: внесите 20–30 позиций — https://detaly.test/admin/prices\nЗа последние 7 дней внесено: 5.',
    });

    // The queued alert goes out through the AlertPort to the sellers chat.
    await processNotify(job('alert', rows[0]!.data), t.deps);
    expect(t.fakes.alerts.calls.at(-1)).toMatchObject({
      audience: 'sellers',
      dedupeKey: 'price-check:2026-10-12',
    });

    // Next Monday: a new reminder.
    clock.now = new Date(MONDAY.getTime() + 7 * DAY);
    expect((await run()).alerted).toBe('alert:price-check:2026-10-19');
  });

  it('stays silent with 20 records in the last 7 days', async () => {
    await addComparisons(PRICE_CHECK_TARGET, new Date(MONDAY.getTime() - 6 * DAY));
    expect(await run()).toEqual({ lastWeek: PRICE_CHECK_TARGET, alerted: null });
    expect(await db.select().from(outbox)).toEqual([]);
  });

  it('the text has the link and no personal data', () => {
    const text = priceCheckText('https://shop.example', 0);
    expect(text).toBe(
      'Пора сверить цены: внесите 20–30 позиций — https://shop.example/admin/prices',
    );
    expect(text).not.toMatch(/\+7|\d{10}/);
  });
});
