// housekeeping/reviews-check (step 3, docs/reviews.md): «Отзывы: обновите рейтинг…» to the
// sellers chat on Mondays at 10:05, skipped without a review link or when the rating snapshot was
// saved in the last 7 days. Its own database (`${workerDatabaseUrl}_ops_rc`): the job reads the
// settings row of the snapshot.
import { createDb, eq, outbox, settings, type Db } from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import { REVIEW_SNAPSHOT_KEY } from '@detaly/domain';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { processHousekeeping, reviewsCheckText } from '../src/jobs/housekeeping';
import type { ReviewsCheckResult } from '../src/jobs/housekeeping/reviews-check';
import { processNotify } from '../src/jobs/notify';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const DAY = 86_400_000;
// Monday 12 October 2026, 10:05 in Orenburg.
const MONDAY = new Date('2026-10-12T05:05:00.000Z');
const clock = { now: new Date(MONDAY) };

function job(name: string, data: Record<string, unknown>): Job {
  return { name, data, attemptsMade: 0, opts: { attempts: 1 } } as unknown as Job;
}

describe.skipIf(!inject('workerDatabaseUrl'))('housekeeping reviews-check', () => {
  let db: Db;
  let t: TestDeps;
  let plain: TestDeps;
  const run = (deps: TestDeps) =>
    processHousekeeping({ name: 'reviews-check' }, deps.deps) as Promise<ReviewsCheckResult>;

  beforeAll(async () => {
    const { url } = await prepareTestDb({ url: `${inject('workerDatabaseUrl')}_ops_rc` });
    db = createDb(url, { max: 4 });
    t = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: {
        APP_BASE_URL: 'https://shop.test',
        REVIEW_URL_YANDEX: 'https://yandex.ru/maps/org/test/1/reviews/',
        REVIEW_URL_2GIS: 'https://2gis.ru/orenburg/firm/1',
      },
    });
    plain = await createTestDeps({
      db,
      now: () => clock.now,
      envOverrides: { APP_BASE_URL: 'https://shop.test' },
    });
  });
  afterAll(async () => {
    await t?.close();
    await plain?.close();
    await db?.close();
  });
  beforeEach(async () => {
    await db.delete(outbox);
    await db.delete(settings).where(eq(settings.key, REVIEW_SNAPSHOT_KEY));
    clock.now = new Date(MONDAY);
  });

  async function saveSnapshot(updatedAt: Date): Promise<void> {
    await db.insert(settings).values({
      key: REVIEW_SNAPSHOT_KEY,
      value: { asOf: '2026-10-01', ratings: { yandex: { ratingX10: 49, count: 37 } } },
      updatedBy: 'admin',
      updatedAt,
    });
  }

  it('reminds the sellers chat once a day while the snapshot is older than 7 days', async () => {
    expect(await run(t)).toEqual({
      skipped: null,
      alerted: 'alert:reviews-check:2026-10-12',
    });
    expect(await run(t)).toEqual({ skipped: null, alerted: null });
    const rows = await db
      .select()
      .from(outbox)
      .where(eq(outbox.jobId, 'alert:reviews-check:2026-10-12'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ queue: 'notify', name: 'alert' });
    expect(rows[0]?.data).toEqual({
      audience: 'sellers',
      dedupeKey: 'reviews-check:2026-10-12',
      text: 'Отзывы: обновите рейтинг в /admin/reviews и ответьте на новые отзывы в Яндекс Бизнесе и 2ГИС — https://shop.test/admin/reviews',
    });
    await processNotify(job('alert', rows[0]!.data), t.deps);
    expect(t.fakes.alerts.calls.at(-1)).toMatchObject({
      audience: 'sellers',
      dedupeKey: 'reviews-check:2026-10-12',
    });

    // A snapshot saved 8 days ago does not stop the next Monday's reminder.
    await saveSnapshot(new Date(MONDAY.getTime() - DAY));
    clock.now = new Date(MONDAY.getTime() + 7 * DAY + 60_000);
    expect((await run(t)).alerted).toBe('alert:reviews-check:2026-10-19');
  });

  it('stays silent when the snapshot was saved in the last 7 days', async () => {
    await saveSnapshot(new Date(MONDAY.getTime() - 6 * DAY));
    expect(await run(t)).toEqual({ skipped: 'fresh', alerted: null });
    expect(await db.select().from(outbox)).toEqual([]);
  });

  it('stays silent without a review link', async () => {
    expect(await run(plain)).toEqual({ skipped: 'no_links', alerted: null });
    expect(await db.select().from(outbox)).toEqual([]);
  });

  it('names only the configured services; no personal data', () => {
    expect(reviewsCheckText('https://shop.example', ['2gis'])).toBe(
      'Отзывы: обновите рейтинг в /admin/reviews и ответьте на новые отзывы в 2ГИС — https://shop.example/admin/reviews',
    );
    expect(reviewsCheckText('https://shop.example', ['yandex'])).toContain('в Яндекс Бизнесе —');
    expect(reviewsCheckText('https://shop.example', ['yandex', '2gis'])).not.toMatch(/\+7|\d{10}/);
  });
});
