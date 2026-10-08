// Step 3 (docs/reviews.md): /admin/reviews against PG — saving the rating snapshot through the
// audited settings writer (validation, settings_audit: who, when, before, after; the version;
// the rating cache dropped), and the read model (links, what the storefront shows, the funnel of
// 30 and 90 days). A database of its own (`<web db>_reviews`): the funnel counts every row.
import { randomBytes, randomInt } from 'node:crypto';
import {
  asc,
  claims,
  createDb,
  eq,
  notifications,
  orderEvents,
  orders,
  settings,
  settingsAudit,
  users,
  type Db,
} from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import { REVIEW_SNAPSHOT_KEY } from '@detaly/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleAdminReviewsAction } from '@/server/admin/reviews-handler';
import { loadAdminReviews, parseSnapshotForm } from '@/server/admin/reviews';
import { intEnv, webDatabaseUrl } from './helpers';

const APP = 'http://127.0.0.1:3100';
const ADMIN = 'admin:reviews-test-password';
const AUTH = `Basic ${Buffer.from(ADMIN, 'utf8').toString('base64')}`;
const YANDEX = 'https://yandex.ru/maps/org/test/1/reviews/';
const TWO_GIS = 'https://2gis.ru/orenburg/firm/1';
const env = intEnv({
  ADMIN_BASIC_AUTH: ADMIN,
  APP_BASE_URL: APP,
  REVIEW_URL_YANDEX: YANDEX,
  REVIEW_URL_2GIS: TWO_GIS,
});
const envBare = intEnv({ ADMIN_BASIC_AUTH: ADMIN, APP_BASE_URL: APP });
/** Tuesday 20 October 2026, 11:00 in Orenburg. */
const NOW = new Date('2026-10-20T06:00:00Z');
const DAY = 86_400_000;

let db: Db;

beforeAll(async () => {
  const base = new URL(webDatabaseUrl());
  base.pathname = `${base.pathname}_reviews`;
  const { url } = await prepareTestDb({ url: base.toString() });
  db = createDb(url, { max: 4 });
});

beforeEach(async () => {
  await db.delete(settingsAudit);
  await db.delete(settings).where(eq(settings.key, REVIEW_SNAPSHOT_KEY));
});

afterAll(async () => {
  await db?.close();
});

function formRequest(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const all: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: APP,
    authorization: AUTH,
    ...headers,
  };
  for (const [key, value] of Object.entries(all)) if (value === '') delete all[key];
  return new Request(`${APP}/api/admin/reviews`, {
    method: 'POST',
    headers: all,
    body: new URLSearchParams(fields).toString(),
  });
}

const FULL = {
  action: 'save',
  version: 'none',
  rating_yandex: '4,9',
  count_yandex: '37',
  rating_2gis: '4.8',
  count_2gis: '12',
  as_of: '2026-10-20',
};

function save(fields: Record<string, string>, invalidated?: { count: number }, at = NOW) {
  return handleAdminReviewsAction(formRequest(fields), {
    db,
    env,
    now: () => at,
    invalidateRating: () => {
      if (invalidated) invalidated.count += 1;
    },
  });
}

function doneOf(response: Response): string {
  return new URL(response.headers.get('location') ?? '', APP).searchParams.get('done') ?? '';
}

describe('the snapshot form', () => {
  it('rating 1,0–5,0 with one decimal (comma or dot), count ≥ 0, both or neither per platform', () => {
    const ok = parseSnapshotForm(new URLSearchParams(FULL), '2026-10-20');
    expect(ok).toEqual({
      ok: true,
      snapshot: {
        asOf: '2026-10-20',
        ratings: { yandex: { ratingX10: 49, count: 37 }, '2gis': { ratingX10: 48, count: 12 } },
      },
    });
    const yandexOnly = parseSnapshotForm(
      new URLSearchParams({ ...FULL, rating_2gis: '', count_2gis: '', as_of: '20.10.2026' }),
      '2026-10-20',
    );
    expect(yandexOnly).toEqual({
      ok: true,
      snapshot: { asOf: '2026-10-20', ratings: { yandex: { ratingX10: 49, count: 37 } } },
    });
    const bad: [Record<string, string>, RegExp][] = [
      [{ rating_yandex: '5,5' }, /Яндекс Карты: оценка — от 1,0 до 5,0/],
      [{ rating_yandex: '4,95' }, /оценка — от 1,0 до 5,0/],
      [{ rating_yandex: '0' }, /оценка/],
      [{ count_2gis: '-1' }, /2ГИС: число отзывов — целое число от 0/],
      [{ count_2gis: '3,5' }, /2ГИС: число отзывов/],
      [{ count_2gis: '' }, /2ГИС: укажите и оценку, и число отзывов/],
      [{ as_of: '2026-10-21' }, /не может быть позже сегодняшнего дня/],
      [{ as_of: '31.02.2026' }, /«На дату» — дата/],
      [{ as_of: '' }, /«На дату» — дата/],
    ];
    for (const [change, message] of bad) {
      const result = parseSnapshotForm(new URLSearchParams({ ...FULL, ...change }), '2026-10-20');
      expect(result.ok, JSON.stringify(change)).toBe(false);
      if (!result.ok) expect(result.errors.join(' '), JSON.stringify(change)).toMatch(message);
    }
  });
});

describe('POST /api/admin/reviews', () => {
  it('refuses without Basic auth, from another site, a wrong body or action', async () => {
    const noAuth = await handleAdminReviewsAction(formRequest(FULL, { authorization: '' }), {
      db,
      env,
    });
    expect(noAuth.status).toBe(401);
    const disabled = await handleAdminReviewsAction(formRequest(FULL), {
      db,
      env: { ...env, ADMIN_BASIC_AUTH: undefined },
    });
    expect(disabled.status).toBe(404);
    const foreign = await handleAdminReviewsAction(
      formRequest(FULL, { origin: 'https://evil.example' }),
      { db, env },
    );
    expect(foreign.status).toBe(403);
    const json = await handleAdminReviewsAction(
      formRequest(FULL, { 'content-type': 'application/json' }),
      { db, env },
    );
    expect(json.status).toBe(400);
    const unknown = await handleAdminReviewsAction(formRequest({ ...FULL, action: 'drop' }), {
      db,
      env,
    });
    expect(unknown.status).toBe(400);
    expect(await db.select().from(settingsAudit)).toEqual([]);
  });

  it('422 with the reason for a bad value; nothing is written', async () => {
    const response = await save({ ...FULL, rating_yandex: '5,3' });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain('Яндекс Карты: оценка — от 1,0 до 5,0');
    expect(await db.select().from(settingsAudit)).toEqual([]);
    expect(await db.select().from(settings).where(eq(settings.key, REVIEW_SNAPSHOT_KEY))).toEqual(
      [],
    );
  });

  it('saves the snapshot with an audit row (who, when, before, after) and drops the cache', async () => {
    const invalidated = { count: 0 };
    const first = await save({ ...FULL }, invalidated);
    expect(first.status).toBe(303);
    expect(doneOf(first)).toBe('Сохранено: Яндекс Карты 4,9 · 37, 2ГИС 4,8 · 12, на 20 октября');
    expect(invalidated.count).toBe(1);
    const [row] = await db.select().from(settings).where(eq(settings.key, REVIEW_SNAPSHOT_KEY));
    const snapshot = {
      asOf: '2026-10-20',
      ratings: { yandex: { ratingX10: 49, count: 37 }, '2gis': { ratingX10: 48, count: 12 } },
    };
    expect(row).toMatchObject({ value: snapshot, updatedBy: 'admin' });
    expect(row?.updatedAt.toISOString()).toBe(NOW.toISOString());
    const audit = await db.select().from(settingsAudit);
    expect(audit).toEqual([
      expect.objectContaining({
        key: REVIEW_SNAPSHOT_KEY,
        oldValue: null,
        newValue: snapshot,
        changedBy: 'admin',
        changedAt: NOW,
      }),
    ]);

    // The same numbers again: nothing written.
    const version = row!.updatedAt.toISOString();
    const same = await save({ ...FULL, version }, invalidated);
    expect(doneOf(same)).toBe('Без изменений');
    expect(await db.select().from(settingsAudit)).toHaveLength(1);

    // An editor opened before the save (the old version): 409.
    const stale = await save({ ...FULL, version: 'none', count_yandex: '38' }, invalidated);
    expect(stale.status).toBe(409);

    // The next week: the old and the new value in the audit, 2ГИС cleared.
    const later = new Date(NOW.getTime() + 7 * DAY);
    const next = await save(
      {
        ...FULL,
        version,
        count_yandex: '41',
        rating_2gis: '',
        count_2gis: '',
        as_of: '2026-10-27',
      },
      invalidated,
      later,
    );
    expect(doneOf(next)).toBe('Сохранено: Яндекс Карты 4,9 · 41, на 27 октября');
    const rows = await db.select().from(settingsAudit).orderBy(asc(settingsAudit.changedAt));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      oldValue: snapshot,
      newValue: { asOf: '2026-10-27', ratings: { yandex: { ratingX10: 49, count: 41 } } },
      changedBy: 'admin',
    });
    expect(invalidated.count).toBe(2);
  });
});

describe('the read model of /admin/reviews', () => {
  async function insertOrder(handedAt: Date | null) {
    const [user] = await db
      .insert(users)
      .values({ phone: `+79${randomInt(100_000_000, 1_000_000_000)}` })
      .returning();
    const [order] = await db
      .insert(orders)
      .values({
        userId: user!.id,
        accessToken: randomBytes(32).toString('base64url'),
        status: handedAt ? 'completed' : 'ordered_at_supplier',
        paymentScheme: 'pay_on_handover',
        subtotalKop: 52_800,
        totalKop: 52_800,
        itemsHash: 'test',
        handedAt,
      })
      .returning();
    return { id: order!.id, userId: user!.id };
  }

  async function sent(
    orderId: string,
    userId: string,
    template: string,
    at: Date,
    status = 'sent',
  ) {
    await db.insert(notifications).values({
      userId,
      orderId,
      channel: 'telegram',
      template,
      dedupeKey: `${orderId}:${template}:${at.getTime()}:${status}`,
      status: status as 'sent',
      sentAt: status === 'sent' ? at : null,
    });
  }

  it('links, the storefront line or why it is hidden, the funnel of 30 and 90 days', async () => {
    const a = await insertOrder(new Date(NOW.getTime() - 20 * DAY));
    const b = await insertOrder(new Date(NOW.getTime() - 60 * DAY));
    const c = await insertOrder(null);
    await sent(a.id, a.userId, 'how_is_it', new Date(NOW.getTime() - 10 * DAY));
    await sent(a.id, a.userId, 'review_reminder', new Date(NOW.getTime() - 7 * DAY));
    await sent(b.id, b.userId, 'how_is_it', new Date(NOW.getTime() - 50 * DAY));
    await sent(b.id, b.userId, 'review_reminder', new Date(NOW.getTime() - 40 * DAY), 'skipped');
    await sent(b.id, b.userId, 'how_is_it', new Date(NOW.getTime() - 100 * DAY));
    for (const [orderId, platform, daysAgo] of [
      [a.id, 'yandex', 9],
      [a.id, '2gis', 9],
      [b.id, 'yandex', 45],
    ] as const) {
      await db.insert(orderEvents).values({
        orderId,
        type: 'review_link_opened',
        actorType: 'client',
        payload: { platform },
        createdAt: new Date(NOW.getTime() - daysAgo * DAY),
      });
    }
    // A claim after the handover counts, a delay claim of an order not yet handed does not.
    const openedAt = new Date(NOW.getTime() - 15 * DAY);
    await db.insert(claims).values({
      orderId: a.id,
      kind: 'defect',
      openedAt,
      deadlineAt: new Date(openedAt.getTime() + 10 * DAY),
      openedVia: 'web',
    });
    await db.insert(claims).values({
      orderId: c.id,
      kind: 'delay',
      openedAt,
      deadlineAt: new Date(openedAt.getTime() + 10 * DAY),
      openedVia: 'web',
    });

    const empty = await loadAdminReviews(db, env, NOW);
    expect(empty.links).toEqual([
      { platform: 'yandex', label: 'Яндекс Карты', url: YANDEX },
      { platform: '2gis', label: '2ГИС', url: TWO_GIS },
    ]);
    expect(empty.enabled).toBe(true);
    expect(empty.storefront).toBeNull();
    expect(empty.hiddenReason).toBe('no_snapshot');
    expect(empty.version).toBe('none');
    expect(empty.today).toBe('2026-10-20');
    expect([empty.minCount, empty.maxAgeDays, empty.reminderDays]).toEqual([5, 45, 3]);
    expect(empty.reviewPageUrl).toBe(`${APP}/review`);
    expect(empty.funnel).toEqual([
      {
        days: 30,
        howIsItSent: 1,
        reminderSent: 1,
        opened: { yandex: 1, '2gis': 1 },
        openedOrders: 1,
        claimsAfterHandover: 1,
      },
      {
        days: 90,
        howIsItSent: 2,
        reminderSent: 1,
        opened: { yandex: 2, '2gis': 1 },
        openedOrders: 2,
        claimsAfterHandover: 1,
      },
    ]);

    await save({ ...FULL, count_2gis: '3' });
    const shown = await loadAdminReviews(db, env, NOW);
    expect(shown.snapshot?.ratings.yandex).toEqual({ ratingX10: 49, count: 37 });
    expect(shown.storefront?.lines.map((line) => line.platform)).toEqual(['yandex']);
    expect(shown.hiddenReason).toBeNull();
    expect(shown.audit).toHaveLength(1);
    expect(shown.audit[0]?.newValue?.ratings['2gis']).toEqual({ ratingX10: 48, count: 3 });

    const old = await loadAdminReviews(db, env, new Date(NOW.getTime() + 46 * DAY));
    expect(old.storefront).toBeNull();
    expect(old.hiddenReason).toBe('too_old');

    const bare = await loadAdminReviews(db, envBare, NOW);
    expect(bare.enabled).toBe(false);
    expect(bare.links.map((link) => link.url)).toEqual([null, null]);
    expect(bare.storefront).toBeNull();
    expect(bare.hiddenReason).toBe('no_links');
  });
});
