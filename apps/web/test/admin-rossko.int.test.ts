// Step 8 (docs/rossko-automation.md): /admin/rossko and /admin/auto-order against PG, on a database
// of their own (`<web db>_rossko`): the settings are shared rows, so the shared web database is
// never touched.
//
// - POST /api/admin/rossko: the status map, the polling switch, the order deadline, the shadow
//   auto-order limit and the cutoff times, each through the audited settings writer (a
//   settings_audit row, nothing for an equal value, 409 on a stale version), 422 for bad fields,
//   Basic auth (401), Origin (403), the content type and the action (400);
// - the read model of /admin/rossko: the codes the polling has seen with their names and counts
//   next to the mapped ones, what the polling looks at, the warning without ROSSKO_MODE=live;
// - /admin/auto-order: the decisions of 30 and 90 days, «Заказать всё равно» after a decision
//   counts as ordered, the reasons, the verdict, no switch of the real auto-order.
import { randomBytes, randomInt } from 'node:crypto';
import {
  and,
  createDb,
  eq,
  orderEvents,
  orderItems,
  orders,
  settings,
  settingsAudit,
  supplierOrderItems,
  supplierOrders,
  users,
  type Db,
} from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import {
  AUTO_ORDER_MAX_TOTAL_KEY,
  ROSSKO_CUTOFF_TIMES_KEY,
  ROSSKO_ORDER_WITHIN_KEY,
  ROSSKO_POLL_ENABLED_KEY,
  ROSSKO_STATUS_MAP_KEY,
  type Offer,
  type OrderItemState,
  type OrderStatus,
} from '@detaly/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminAutoOrder } from '@/components/admin/AdminAutoOrder';
import { AdminRossko } from '@/components/admin/AdminRossko';
import { loadAdminAutoOrder } from '@/server/admin/auto-order';
import { loadAdminRossko, statusMapFromForm } from '@/server/admin/rossko';
import { handleAdminRosskoAction } from '@/server/admin/rossko-handler';
import { intEnv, webDatabaseUrl } from './helpers';

const APP = 'http://127.0.0.1:3100';
const ADMIN = 'admin:rossko-test-password';
const AUTH = `Basic ${Buffer.from(ADMIN, 'utf8').toString('base64')}`;
const env = intEnv({ ADMIN_BASIC_AUTH: ADMIN, APP_BASE_URL: APP });
const NOW = new Date('2026-10-15T06:00:00.000Z');
const DAY = 86_400_000;

let db: Db;

const OFFER: Offer = {
  source: 'rossko',
  brand: 'Knecht',
  article: 'OC 90',
  articleNorm: 'OC90',
  name: 'Фильтр масляный',
  group: null,
  isCross: false,
  priceSupplierKop: 41_250,
  stock: {
    stockId: 'ORB1',
    isLocal: true,
    count: 4,
    multiplicity: 1,
    type: null,
    deliveryDays: 1,
    deliveryStart: null,
    deliveryEnd: null,
    extra: null,
    description: null,
  },
};

async function seedOrder(
  status: OrderStatus = 'ordered_at_supplier',
  itemState: OrderItemState = 'ordered',
): Promise<{ orderId: string; number: string; itemId: string }> {
  const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  const [user] = await db.insert(users).values({ phone }).returning({ id: users.id });
  const [order] = await db
    .insert(orders)
    .values({
      userId: user!.id,
      accessToken: randomBytes(32).toString('base64url'),
      status,
      paymentScheme: 'prepay',
      subtotalKop: 52_800,
      totalKop: 52_800,
      itemsHash: 'test',
    })
    .returning({ id: orders.id, number: orders.number });
  const [item] = await db
    .insert(orderItems)
    .values({
      orderId: order!.id,
      offerKey: 'OC90:Knecht:ORB1',
      searchArticleNorm: 'OC90',
      brand: 'Knecht',
      article: 'OC 90',
      name: 'Фильтр масляный',
      qty: 1,
      stockId: 'ORB1',
      isLocal: true,
      priceSupplierAtOrderKop: 41_250,
      priceClientKop: 52_800,
      markupBp: 2800,
      offerSnapshot: OFFER,
      state: itemState,
    })
    .returning({ id: orderItems.id });
  return { orderId: order!.id, number: order!.number, itemId: item!.id };
}

async function journal(
  orderId: string,
  type: string,
  at: Date,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(orderEvents).values({
    orderId,
    type,
    actorType: 'system',
    actorId: 'test',
    payload,
    createdAt: at,
  });
}

function formRequest(
  fields: [string, string][] | Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  const all: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: APP,
    authorization: AUTH,
    ...headers,
  };
  for (const [key, value] of Object.entries(all)) if (value === '') delete all[key];
  return new Request(`${APP}/api/admin/rossko`, {
    method: 'POST',
    headers: all,
    body: new URLSearchParams(fields).toString(),
  });
}

function doneOf(response: Response): string {
  const location = response.headers.get('location') ?? '';
  return new URL(location, APP).searchParams.get('done') ?? '';
}

async function post(fields: [string, string][] | Record<string, string>, headers = {}) {
  return handleAdminRosskoAction(formRequest(fields, headers), { db, env, now: () => NOW });
}

async function stored(key: string): Promise<unknown> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row?.value;
}

async function audits(key: string) {
  return db.select().from(settingsAudit).where(eq(settingsAudit.key, key));
}

beforeAll(async () => {
  const base = new URL(webDatabaseUrl());
  base.pathname = `${base.pathname}_rossko`;
  const { url } = await prepareTestDb({ url: base.toString() });
  db = createDb(url, { max: 4 });
});

afterAll(async () => {
  await db?.close();
});

describe('POST /api/admin/rossko', () => {
  it('the status map: saved with an audit row, «Без изменений» twice, 409 on a stale version', async () => {
    const data = await loadAdminRossko(db, env);
    expect(data.statusMap.value).toEqual({});
    const fields: [string, string][] = [
      ['action', 'map'],
      ['version', data.statusMap.version],
      ['code', '9'],
      ['act', 'refused'],
      ['code', '03'],
      ['act', 'shipped_to_point'],
      ['code', '1'],
      ['act', ''],
      ['code', ''],
      ['act', ''],
    ];
    const saved = await post(fields);
    expect(saved.status).toBe(303);
    expect(doneOf(saved)).toBe('Коды статусов сохранены: 2');
    expect(await stored(ROSSKO_STATUS_MAP_KEY)).toEqual({
      '3': 'shipped_to_point',
      '9': 'refused',
    });
    const rows = await audits(ROSSKO_STATUS_MAP_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oldValue: {}, changedBy: 'admin', changedAt: NOW });

    const fresh = await loadAdminRossko(db, env);
    const again = await post(
      fields.map(([key, value]): [string, string] =>
        key === 'version' ? [key, fresh.statusMap.version] : [key, value],
      ),
    );
    expect(doneOf(again)).toBe('Без изменений');
    expect(await audits(ROSSKO_STATUS_MAP_KEY)).toHaveLength(1);

    const stale = await post(fields);
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain('Настройку уже изменили');
  });

  it('the status map: a code twice, a bad code or action is refused with a message', () => {
    const parse = (pairs: [string, string][]) => statusMapFromForm(new URLSearchParams(pairs));
    expect(
      parse([
        ['code', '3'],
        ['act', 'ignore'],
        ['code', '3'],
        ['act', 'refused'],
      ]),
    ).toEqual({ ok: false, message: 'Код 3 указан дважды' });
    expect(
      parse([
        ['code', '1234567'],
        ['act', 'ignore'],
      ]),
    ).toMatchObject({ ok: false });
    expect(
      parse([
        ['code', 'x1'],
        ['act', 'ignore'],
      ]),
    ).toMatchObject({ ok: false });
    expect(
      parse([
        ['code', '3'],
        ['act', 'order_now'],
      ]),
    ).toEqual({
      ok: false,
      message: 'Неизвестное действие',
    });
    expect(
      parse([
        ['code', ''],
        ['act', 'refused'],
      ]),
    ).toEqual({
      ok: false,
      message: 'Укажите код для выбранного действия',
    });
    expect(parse([['code', '3']])).toMatchObject({ ok: false });
    expect(parse([])).toEqual({ ok: true, map: {} });
  });

  it('the polling switch is stored; without ROSSKO_MODE=live the answer says so', async () => {
    const data = await loadAdminRossko(db, env);
    expect(data.mode).toBe('fixtures');
    const on = await post({ action: 'poll', enabled: 'on', version: data.pollEnabled.version });
    expect(doneOf(on)).toBe(
      'Опрос Rossko включён, но работать начнёт только с ROSSKO_MODE=live (ключи Rossko)',
    );
    expect(await stored(ROSSKO_POLL_ENABLED_KEY)).toBe(true);
    const bad = await post({ action: 'poll', enabled: 'yes', version: 'none' });
    expect(bad.status).toBe(422);
    const fresh = await loadAdminRossko(db, env);
    const off = await post({ action: 'poll', enabled: 'off', version: fresh.pollEnabled.version });
    expect(doneOf(off)).toBe('Опрос Rossko выключен');
    expect(await stored(ROSSKO_POLL_ENABLED_KEY)).toBe(false);
    expect((await audits(ROSSKO_POLL_ENABLED_KEY)).map((row) => row.newValue)).toEqual([
      true,
      false,
    ]);
  });

  it('the order deadline, the auto-order limit and the cutoff times', async () => {
    let data = await loadAdminRossko(db, env);
    expect(data.orderWithinMinutes.value).toBe(120);
    const within = await post({
      action: 'within',
      minutes: '90',
      version: data.orderWithinMinutes.version,
    });
    expect(doneOf(within)).toBe('«Не заказано у поставщика» — после 1 ч 30 мин рабочего времени');
    expect(await stored(ROSSKO_ORDER_WITHIN_KEY)).toBe(90);
    for (const minutes of ['5', '2000', 'abc', '']) {
      const refused = await post({ action: 'within', minutes, version: 'none' });
      expect(refused.status, minutes).toBe(422);
    }

    data = await loadAdminRossko(db, env);
    expect(data.autoOrderMaxTotalKop.value).toBe(1_500_000);
    const limit = await post({
      action: 'max_total',
      rub: '20 000',
      version: data.autoOrderMaxTotalKop.version,
    });
    expect(doneOf(limit).replace(/\s/gu, ' ')).toBe('Порог теневого автозаказа: 20 000 ₽');
    expect(await stored(AUTO_ORDER_MAX_TOTAL_KEY)).toBe(2_000_000);
    for (const rub of ['-1', '600000', 'много']) {
      expect((await post({ action: 'max_total', rub, version: 'none' })).status, rub).toBe(422);
    }

    data = await loadAdminRossko(db, env);
    expect(data.cutoffTimes.value).toEqual([]);
    const cutoffs = await post({
      action: 'cutoffs',
      times: '16:00, 11:00',
      version: data.cutoffTimes.version,
    });
    expect(doneOf(cutoffs)).toBe('Отсечки Rossko: 11:00, 16:00');
    expect(await stored(ROSSKO_CUTOFF_TIMES_KEY)).toEqual(['11:00', '16:00']);
    expect((await post({ action: 'cutoffs', times: '25:00', version: 'none' })).status).toBe(422);
    data = await loadAdminRossko(db, env);
    const cleared = await post({ action: 'cutoffs', times: '', version: data.cutoffTimes.version });
    expect(doneOf(cleared)).toBe('Отсечки Rossko очищены');
    expect(await stored(ROSSKO_CUTOFF_TIMES_KEY)).toEqual([]);
    // Every save left its audit row.
    expect(await audits(ROSSKO_CUTOFF_TIMES_KEY)).toHaveLength(2);
  });

  it('Basic auth, Origin, the content type and the action', async () => {
    const noAuth = await post({ action: 'poll', enabled: 'on' }, { authorization: '' });
    expect(noAuth.status).toBe(401);
    const foreign = await post(
      { action: 'poll', enabled: 'on' },
      { origin: 'https://evil.example' },
    );
    expect(foreign.status).toBe(403);
    const json = await handleAdminRosskoAction(
      new Request(`${APP}/api/admin/rossko`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP, authorization: AUTH },
        body: '{}',
      }),
      { db, env },
    );
    expect(json.status).toBe(400);
    expect((await post({ action: 'auto_order_on' })).status).toBe(400);
    // Nothing above reached the settings.
    expect(await stored(ROSSKO_POLL_ENABLED_KEY)).toBe(false);
  });
});

describe('/admin/rossko: what the polling has seen', () => {
  it('observed codes with names and counts next to the mapped ones; the open supplier orders', async () => {
    const first = await seedOrder();
    const second = await seedOrder();
    const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000);
    await journal(first.orderId, 'rossko_status', at(5), {
      code: 3,
      name: 'Отгружен',
      action: 'x',
    });
    await journal(second.orderId, 'rossko_status', at(4), {
      code: 3,
      name: 'Отгружен на точку',
      action: 'x',
    });
    await journal(second.orderId, 'rossko_status', at(3), {
      code: 7,
      name: null,
      action: 'unmapped',
    });
    // A late mapping is not a new observation.
    await journal(second.orderId, 'rossko_status', at(2), { code: 7, mappedLater: true });
    const [so] = await db
      .insert(supplierOrders)
      .values({
        orderId: first.orderId,
        attemptNo: 1,
        status: 'created',
        rosskoOrderIds: ['70000010'],
        statusCheckedAt: at(1),
      })
      .returning({ id: supplierOrders.id });
    await db
      .insert(supplierOrderItems)
      .values({ supplierOrderId: so!.id, orderItemId: first.itemId });

    const data = await loadAdminRossko(db, env);
    expect(data.rows.map((row) => [row.code, row.action, row.count, row.names])).toEqual([
      ['3', 'shipped_to_point', 2, ['Отгружен на точку', 'Отгружен']],
      ['7', null, 1, []],
      ['9', 'refused', 0, []],
    ]);
    expect(data.polling).toEqual({ open: 1, lastCheckedAt: at(1) });

    const html = renderToStaticMarkup(createElement(AdminRossko, { data, done: 'Сохранено' }));
    expect(html).toContain('data-testid="rossko-mode-warning"');
    expect(html).toContain('ROSSKO_MODE=fixtures');
    expect(html).toContain('Отгружен на точку / Отгружен');
    expect(html).toContain('Не задано — только сообщение «что это значит?»');
    // The forms of the page: the five settings, never a switch of the real auto-order.
    expect([...html.matchAll(/name="action" value="([a-z_]+)"/gu)].map((m) => m[1])).toEqual([
      'poll',
      'map',
      'within',
      'cutoffs',
      'max_total',
    ]);
    const live = renderToStaticMarkup(
      createElement(AdminRossko, { data: { ...data, mode: 'live' }, done: null }),
    );
    expect(live).not.toContain('data-testid="rossko-mode-warning"');
  });
});

describe('/admin/auto-order: the shadow statistics', () => {
  it('30 and 90 days, «Заказать всё равно» counts, the reasons and the verdict', async () => {
    const shadow = async (
      daysAgo: number,
      decision: 'yes' | 'no',
      masterOrdered: boolean,
      reasons: string[] = [],
    ) => {
      const order = await seedOrder('ordering', 'pending');
      const at = new Date(NOW.getTime() - daysAgo * DAY);
      await journal(order.orderId, 'auto_order_shadow', at, {
        decision,
        reasons,
        masterOrdered,
        maxTotalKop: 1_500_000,
      });
      return { ...order, at };
    };
    await shadow(1, 'yes', true);
    await shadow(2, 'no', false, ['price_drift']);
    const anyway = await shadow(3, 'no', false, ['total_over_limit', 'no_show']);
    await journal(anyway.orderId, 'order_anyway', new Date(anyway.at.getTime() + 3_600_000));
    await shadow(40, 'yes', false);
    await shadow(120, 'yes', true); // older than 90 days: not counted

    const data = await loadAdminAutoOrder(db, NOW);
    const [d30, d90] = data.periods;
    expect(d30).toMatchObject({
      days: 30,
      stats: { decisions: 3, yes: 1, no: 2, agreements: 2, yesNotOrdered: 0, noButOrdered: 1 },
      verdict: { kind: 'few' },
    });
    expect(d30!.stats.reasons).toMatchObject({ price_drift: 1, total_over_limit: 1, no_show: 1 });
    expect(d90).toMatchObject({
      days: 90,
      stats: { decisions: 4, agreements: 2, yesNotOrdered: 1 },
      verdict: { kind: 'few', text: 'Мало данных: совпадений 2 из 4, нужно хотя бы 30 решений.' },
    });
    expect(data.recent.map((row) => [row.decision, row.masterOrdered])).toEqual([
      ['yes', true],
      ['no', false],
      ['no', true],
      ['yes', false],
    ]);

    const html = renderToStaticMarkup(createElement(AdminAutoOrder, { data }));
    expect(html).toContain('Мало данных: совпадений 2 из 3, нужно хотя бы 30 решений.');
    expect(html).toContain('цена у поставщика выросла больше допуска');
    // A read-only page: no form, no switch of the real auto-order.
    expect(html).not.toContain('<form');
    expect(html).not.toContain('type="submit"');
  });

  it('the verdict «можно обсуждать» with 30 decisions and 95 % agreement', async () => {
    const base = new Date(NOW.getTime() - 5 * DAY);
    const order = await seedOrder('ordering', 'pending');
    // «ДА» 30 times; the master did not order the first one.
    for (let i = 0; i < 30; i += 1) {
      await journal(order.orderId, 'auto_order_shadow', new Date(base.getTime() + i * 60_000), {
        decision: 'yes',
        reasons: [],
        masterOrdered: i !== 0,
        maxTotalKop: 1_500_000,
      });
    }
    const data = await loadAdminAutoOrder(db, NOW);
    const [d30] = data.periods;
    // 3 decisions of the previous test plus these 30.
    expect(d30!.stats.decisions).toBe(33);
    expect(d30!.stats.agreements).toBe(31);
    expect(d30!.verdict).toEqual({
      kind: 'early',
      text: 'Рано: совпадений 31 из 33, нужно не меньше 95%.',
    });
    // 40 more agreeing decisions: 71 of 73 is 97 %.
    for (let i = 30; i < 70; i += 1) {
      await journal(order.orderId, 'auto_order_shadow', new Date(base.getTime() + i * 60_000), {
        decision: 'yes',
        reasons: [],
        masterOrdered: true,
        maxTotalKop: 1_500_000,
      });
    }
    const more = await loadAdminAutoOrder(db, NOW);
    expect(more.periods[0]!.stats).toMatchObject({ decisions: 73, agreements: 71 });
    expect(more.periods[0]!.verdict).toEqual({
      kind: 'discuss',
      text: 'Совпадений 71 из 73 — можно обсуждать автозаказ.',
    });
    expect(
      await db
        .select()
        .from(orderEvents)
        .where(and(eq(orderEvents.orderId, order.orderId), eq(orderEvents.type, 'order_anyway'))),
    ).toEqual([]);
  });
});
