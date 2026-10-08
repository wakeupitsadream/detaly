// Step 3 (docs/reviews.md): GET /o/<token>/review/<platform> against local PG — the first open per
// platform is journaled once (no status change, not on the timeline), then 302 to the configured
// link with no-referrer, no-store and noindex; the 404 cases; HEAD and prefetches are not
// counted; the demo redirects without a database. And «Оцените нас» on the order page: after the
// handover only, with our redirect links, nothing without a review link.
import { randomBytes, randomInt } from 'node:crypto';
import { and, createDb, eq, orderEvents, orderItems, orders, users, type Db } from '@detaly/db';
import type { Offer, OrderStatus } from '@detaly/domain';
import type * as Navigation from 'next/navigation';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderDetails } from '@/components/order/OrderDetails';
import { loadOrderView } from '@/server/orders/order-view';
import { orderReviewLinks } from '@/server/reviews/links';
import {
  countsAsOpen,
  handleReviewRedirect,
  type ReviewRedirectDeps,
} from '@/server/reviews/redirect';
import { intEnv, webDatabaseUrl } from './helpers';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const APP = 'http://127.0.0.1:3100';
const YANDEX = 'https://yandex.ru/maps/org/test/1/reviews/';
const TWO_GIS = 'https://2gis.ru/orenburg/firm/1';
const ENV = intEnv({ APP_BASE_URL: APP, REVIEW_URL_YANDEX: YANDEX, REVIEW_URL_2GIS: TWO_GIS });
const ENV_YANDEX_ONLY = intEnv({ APP_BASE_URL: APP, REVIEW_URL_YANDEX: YANDEX });
const ENV_BARE = intEnv({ APP_BASE_URL: APP });

let db: Db;

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 6 });
});

afterAll(async () => {
  await db.close();
});

function offer(): Offer {
  return {
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
      count: 10,
      multiplicity: 1,
      type: null,
      deliveryDays: 0,
      deliveryStart: null,
      deliveryEnd: null,
      extra: null,
      description: null,
    },
  };
}

async function insertOrder(status: OrderStatus = 'completed') {
  const phone = `+79${randomInt(100_000_000, 1_000_000_000)}`;
  const [user] = await db.insert(users).values({ phone }).returning();
  const token = randomBytes(32).toString('base64url');
  const after = status === 'handed' || status === 'completed';
  const [order] = await db
    .insert(orders)
    .values({
      userId: user!.id,
      accessToken: token,
      status,
      paymentScheme: 'pay_on_handover',
      subtotalKop: 52_800,
      totalKop: 52_800,
      itemsHash: 'test',
      promisedDate: '2026-10-08',
      pickupCode: '482913',
      handedAt: after ? new Date(Date.now() - 8 * 86_400_000) : null,
      completedAt: status === 'completed' ? new Date(Date.now() - 86_400_000) : null,
    })
    .returning();
  await db.insert(orderItems).values({
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
    etaDate: '2026-10-03',
    offerSnapshot: offer(),
    state: after ? 'handed' : 'arrived',
  });
  await db.insert(orderEvents).values({
    orderId: order!.id,
    type: 'checkout',
    fromStatus: 'draft',
    toStatus: 'awaiting_confirmation',
    actorType: 'client',
    actorId: user!.id,
    payload: { scheme: 'pay_on_handover' },
  });
  return { id: order!.id, token, userId: user!.id, status };
}

function deps(over: Partial<ReviewRedirectDeps> = {}): ReviewRedirectDeps {
  return { env: ENV, db, ...over };
}

function navigation(path: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(`${APP}${path}`, {
    method,
    headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', ...headers },
  });
}

async function opens(orderId: string) {
  return db
    .select({
      type: orderEvents.type,
      payload: orderEvents.payload,
      from: orderEvents.fromStatus,
      to: orderEvents.toStatus,
      actorType: orderEvents.actorType,
      actorId: orderEvents.actorId,
    })
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.type, 'review_link_opened')));
}

function expectPrivateHeaders(response: Response): void {
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
}

describe('GET /o/<token>/review/<platform>', () => {
  it('302 to the configured link; the first open per platform is journaled once', async () => {
    const order = await insertOrder('completed');
    const path = (platform: string) => `/o/${order.token}/review/${platform}`;
    const yandex = await handleReviewRedirect(
      navigation(path('yandex')),
      { token: order.token, platform: 'yandex' },
      deps(),
    );
    expect(yandex.status).toBe(302);
    expect(yandex.headers.get('location')).toBe(YANDEX);
    expectPrivateHeaders(yandex);
    expect(await yandex.text()).toBe('');

    // Opened again (another tap, a second tab): still one row.
    await handleReviewRedirect(
      navigation(path('yandex')),
      { token: order.token, platform: 'yandex' },
      deps(),
    );
    expect(await opens(order.id)).toEqual([
      {
        type: 'review_link_opened',
        payload: { platform: 'yandex' },
        from: null,
        to: null,
        actorType: 'client',
        actorId: order.userId,
      },
    ]);

    const twoGis = await handleReviewRedirect(
      navigation(path('2gis')),
      { token: order.token, platform: '2gis' },
      deps(),
    );
    expect(twoGis.status).toBe(302);
    expect(twoGis.headers.get('location')).toBe(TWO_GIS);
    expect((await opens(order.id)).map((row) => row.payload)).toEqual([
      { platform: 'yandex' },
      { platform: '2gis' },
    ]);
    // The order did not move.
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(after?.status).toBe('completed');
  });

  it('two opens at once write one row (the order row lock)', async () => {
    const order = await insertOrder('handed');
    await Promise.all(
      Array.from({ length: 4 }, () =>
        handleReviewRedirect(
          navigation(`/o/${order.token}/review/2gis`),
          { token: order.token, platform: '2gis' },
          deps(),
        ),
      ),
    );
    expect(await opens(order.id)).toHaveLength(1);
  });

  it('404: an unknown platform, a platform without its link, a bad or unknown token', async () => {
    const order = await insertOrder('completed');
    const cases: [string, string, ReviewRedirectDeps][] = [
      [order.token, 'google', deps()],
      [order.token, 'Yandex', deps()],
      [order.token, '2gis', deps({ env: ENV_YANDEX_ONLY })],
      [order.token, 'yandex', deps({ env: ENV_BARE })],
      ['short', 'yandex', deps()],
      [`${order.token.slice(0, 42)}.`, 'yandex', deps()],
      [randomBytes(32).toString('base64url'), 'yandex', deps()],
      ['demo', 'yandex', deps()],
    ];
    for (const [token, platform, d] of cases) {
      const response = await handleReviewRedirect(
        navigation(`/o/${token}/review/${platform}`),
        { token, platform },
        d,
      );
      expect(response.status, `${token} ${platform}`).toBe(404);
      expect(response.headers.get('location')).toBeNull();
      expectPrivateHeaders(response);
      expect(response.headers.get('content-type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('Страница не найдена');
      expect(html).not.toContain(token);
    }
    expect(await opens(order.id)).toEqual([]);
  });

  it('HEAD, prefetches and subresource requests redirect without counting', async () => {
    const order = await insertOrder('completed');
    const path = `/o/${order.token}/review/yandex`;
    const params = { token: order.token, platform: 'yandex' };
    const requests = [
      navigation(path, {}, 'HEAD'),
      navigation(path, { 'sec-purpose': 'prefetch' }),
      navigation(path, { purpose: 'prefetch' }),
      navigation(path, { 'next-router-prefetch': '1' }),
      navigation(path, { 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors' }),
      navigation(path, { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }),
    ];
    for (const request of requests) {
      const response = await handleReviewRedirect(request, params, deps());
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(YANDEX);
    }
    expect(await opens(order.id)).toEqual([]);
    // A navigation from outside the site (the messenger opens the link) counts; so does a client
    // that sends no Sec-Fetch headers at all.
    await handleReviewRedirect(
      navigation(path, { 'sec-fetch-site': 'cross-site' }),
      params,
      deps(),
    );
    expect(await opens(order.id)).toHaveLength(1);
    expect(countsAsOpen('GET', new Headers())).toBe(true);
    expect(countsAsOpen('POST', new Headers())).toBe(false);
  });

  it('a database failure still sends the client on, without the token in the log', async () => {
    const order = await insertOrder('completed');
    const warnings: Record<string, unknown>[] = [];
    const broken = {
      select: () => {
        throw new Error(`Failed query: select … params: ${order.token}`);
      },
      transaction: () => Promise.reject(new Error(`Failed query … params: ${order.token}`)),
    } as unknown as Db;
    const response = await handleReviewRedirect(
      navigation(`/o/${order.token}/review/yandex`),
      { token: order.token, platform: 'yandex' },
      deps({ db: broken, logger: { warn: (details) => warnings.push(details) } }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(YANDEX);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain(order.token);
  });

  it('DEMO_MODE: the sample order redirects without a database, other tokens are 404', async () => {
    const demoEnv = { ...ENV, DEMO_MODE: true };
    const demo = await handleReviewRedirect(
      navigation('/o/demo/review/2gis'),
      { token: 'demo', platform: '2gis' },
      { env: demoEnv, db: null },
    );
    expect(demo.status).toBe(302);
    expect(demo.headers.get('location')).toBe(TWO_GIS);
    expectPrivateHeaders(demo);
    const other = await handleReviewRedirect(
      navigation('/o/abc/review/2gis'),
      { token: randomBytes(32).toString('base64url'), platform: '2gis' },
      { env: demoEnv, db: null },
    );
    expect(other.status).toBe(404);
    const noLinks = await handleReviewRedirect(
      navigation('/o/demo/review/2gis'),
      { token: 'demo', platform: '2gis' },
      { env: { ...ENV_BARE, DEMO_MODE: true }, db: null },
    );
    expect(noLinks.status).toBe(404);
  });

  it('the open is a service record: not on the client timeline', async () => {
    const order = await insertOrder('completed');
    await handleReviewRedirect(
      navigation(`/o/${order.token}/review/yandex`),
      { token: order.token, platform: 'yandex' },
      deps(),
    );
    const view = await loadOrderView(db, order.token, { env: ENV, paymentsEnabled: false });
    expect(view?.timeline.map((entry) => entry.text).join(' ')).not.toMatch(/отзыв/i);
  });
});

describe('«Оцените нас» on the order page', () => {
  async function page(status: OrderStatus, env = ENV) {
    const order = await insertOrder(status);
    const view = await loadOrderView(db, order.token, { env, paymentsEnabled: false });
    if (!view) throw new Error('no view');
    const html = renderToStaticMarkup(
      createElement(OrderDetails, {
        view,
        pickup: { name: null, address: null, hours: null, phone: null },
        contactPhone: null,
        cartReminder: null,
        // The claims card of an order after the handover (the #claim anchor of the review card).
        services: {
          messenger: null,
          install: null,
          claims: { form: null, claims: [], memoUrl: '/print/pamyatka-vozvrat.pdf', demo: false },
          photos: [],
          demo: false,
        },
        reviews: orderReviewLinks(env, order.token),
      }),
    );
    return { html, token: order.token };
  }

  it('after the handover: both buttons to our redirect and the way to the claim', async () => {
    for (const status of ['handed', 'completed'] as const) {
      const { html, token } = await page(status);
      expect(html, status).toContain('data-testid="order-reviews"');
      expect(html).toContain('Оцените нас');
      expect(html).toContain(`href="/o/${token}/review/yandex"`);
      expect(html).toContain(`href="/o/${token}/review/2gis"`);
      expect(html).toContain('Отзыв в Яндекс Картах');
      expect(html).toContain('Отзыв в 2ГИС');
      expect(html).toContain('href="#claim"');
      expect(html).toMatch(/Что-то не так\?/);
      // Never the map services directly from the order page.
      expect(html).not.toContain(YANDEX);
      expect(html).not.toContain(TWO_GIS);
      // Below the claims and above the history.
      const card = html.indexOf('data-testid="order-reviews"');
      expect(card).toBeGreaterThan(html.indexOf('data-testid="order-claims"'));
      expect(card).toBeLessThan(html.indexOf('data-testid="order-timeline"'));
    }
  });

  it('only the configured platform; nothing without a link or before the handover', async () => {
    const yandexOnly = await page('completed', ENV_YANDEX_ONLY);
    expect(yandexOnly.html).toContain('/review/yandex');
    expect(yandexOnly.html).not.toContain('/review/2gis');
    expect((await page('completed', ENV_BARE)).html).not.toContain('order-reviews');
    for (const status of ['ready', 'refund_pending', 'cancelled'] as const) {
      expect((await page(status)).html, status).not.toContain('order-reviews');
    }
  });
});
