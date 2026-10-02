// /o/<token> read model, rendering and POST /api/orders/<token>/cancel against local PG and
// Redis. Orders are inserted directly (no dependency on the checkout package); every test
// uses its own phone and token, Redis keys live under test:<uuid>:.
import { randomBytes, randomInt } from 'node:crypto';
import { createRedis, resetEnvCache, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import {
  asc,
  createDb,
  eq,
  orderEvents,
  orderItems,
  orders,
  payments,
  users,
  type Db,
} from '@detaly/db';
import type { NotificationChannel, Offer, OrderStatus, PaymentStatus } from '@detaly/domain';
import type * as Navigation from 'next/navigation';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderDetails } from '@/components/order/OrderDetails';
import { resetSingleton } from '@/server/globals';
import { CANCEL_FAIL_LIMIT, cancelFailKey } from '@/server/orders/cancel';
import { handleCancelRequest, type CancelHandlerDeps } from '@/server/orders/cancel-handler';
import type { CartReminder } from '@/server/orders/cart-reminder';
import { findOrderNumber, loadOrderView, type OrderView } from '@/server/orders/order-view';
import { webDatabaseUrl } from './helpers';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const APP = 'http://127.0.0.1:3100';
const prefix = testKeyPrefix();
let db: Db;
let redis: Redis;

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 4 });
  redis = createRedis(testRedisUrl());
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
  await db.close();
});

function deps(overrides: Partial<CancelHandlerDeps> = {}): CancelHandlerDeps {
  return { db, redis, keyPrefix: prefix, appBaseUrl: APP, ...overrides };
}

function offer(brand: string, article: string, name: string, isLocal: boolean): Offer {
  return {
    source: 'rossko',
    brand,
    article,
    articleNorm: article.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
    name,
    group: null,
    isCross: false,
    priceSupplierKop: 41_250,
    stock: {
      stockId: isLocal ? 'ORB1' : 'MSK7',
      isLocal,
      count: 10,
      multiplicity: 1,
      type: null,
      deliveryDays: isLocal ? 0 : 3,
      deliveryStart: null,
      deliveryEnd: null,
      extra: null,
      description: null,
    },
  };
}

interface Inserted {
  id: string;
  token: string;
  number: string;
  userId: string;
  phone: string;
  last4: string;
}

async function insertOrder({
  status = 'awaiting_payment',
  scheme = status === 'awaiting_confirmation' ? 'pay_on_handover' : 'prepay',
  preferredChannel = 'max',
  expiresAt = null,
  phone = `+79${randomInt(100_000_000, 1_000_000_000)}`,
  checkoutAt = new Date(Date.now() - 60_000),
}: {
  status?: OrderStatus;
  scheme?: 'prepay' | 'pay_on_handover';
  preferredChannel?: NotificationChannel | null;
  expiresAt?: Date | null;
  phone?: string;
  /** Time of the checkout event (and of the order row). */
  checkoutAt?: Date;
} = {}): Promise<Inserted> {
  const [user] = await db
    .insert(users)
    .values({ phone, name: 'Тест Тестов' })
    .onConflictDoUpdate({ target: users.phone, set: { name: 'Тест Тестов' } })
    .returning();
  if (!user) throw new Error('user not inserted');
  const token = randomBytes(32).toString('base64url');
  const knecht = offer('Knecht', 'OC 90', 'Фильтр масляный', true);
  const bosch = offer('BOSCH', '0 451 103 079', 'Фильтр масляный', false);
  const [order] = await db
    .insert(orders)
    .values({
      userId: user.id,
      accessToken: token,
      status,
      paymentScheme: scheme,
      subtotalKop: 2 * 52_800 + 117_000,
      totalKop: 2 * 52_800 + 117_000,
      itemsHash: 'test',
      promisedDate: '2026-10-08',
      pickupCode: '482913',
      preferredChannel,
      expiresAt,
      createdAt: checkoutAt,
    })
    .returning();
  if (!order) throw new Error('order not inserted');
  await db.insert(orderItems).values([
    {
      orderId: order.id,
      offerKey: 'OC90:Knecht:ORB1',
      searchArticleNorm: 'OC90',
      brand: 'Knecht',
      article: 'OC 90',
      name: 'Фильтр масляный',
      qty: 2,
      stockId: 'ORB1',
      isLocal: true,
      priceSupplierAtOrderKop: 41_250,
      priceClientKop: 52_800,
      markupBp: 2800,
      etaDate: '2026-10-03',
      offerSnapshot: knecht,
      createdAt: new Date('2026-10-02T09:05:00Z'),
    },
    {
      orderId: order.id,
      offerKey: '0451103079:BOSCH:MSK7',
      searchArticleNorm: 'OC90',
      brand: 'BOSCH',
      article: '0 451 103 079',
      name: 'Фильтр масляный',
      qty: 1,
      stockId: 'MSK7',
      isLocal: false,
      priceSupplierAtOrderKop: 90_000,
      priceClientKop: 117_000,
      markupBp: 3000,
      etaDate: '2026-10-07',
      offerSnapshot: bosch,
      createdAt: new Date('2026-10-02T09:05:01Z'),
    },
  ]);
  const toStatus = status === 'draft' ? null : status;
  if (toStatus !== null) {
    await db.insert(orderEvents).values({
      orderId: order.id,
      type: 'checkout',
      fromStatus: 'draft',
      toStatus:
        toStatus === 'awaiting_payment' || toStatus === 'awaiting_confirmation'
          ? toStatus
          : 'awaiting_payment',
      actorType: 'client',
      actorId: user.id,
      payload: { scheme },
      createdAt: checkoutAt,
    });
  }
  return {
    id: order.id,
    token,
    number: order.number,
    userId: user.id,
    phone,
    last4: phone.slice(-4),
  };
}

async function insertPayment(orderId: string, status: PaymentStatus, createdAt = new Date()) {
  await db.insert(payments).values({
    orderId,
    kind: 'prepayment',
    status,
    amountKop: 222_600,
    idempotenceKey: randomBytes(16).toString('hex'),
    createdAt,
  });
}

function cancelRequest(
  token: string,
  body: unknown,
  headers: Record<string, string> = { Origin: APP },
): Request {
  return new Request(`${APP}/api/orders/${token}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function cancel(token: string, body: unknown, headers?: Record<string, string>) {
  const response = await handleCancelRequest(cancelRequest(token, body, headers), token, deps());
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function orderRow(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error('order missing');
  return row;
}

async function eventsOf(id: string) {
  return db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, id))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
}

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const PICKUP = {
  name: 'Тестовый пункт выдачи',
  address: 'г. Оренбург, ул. Тестовая, 1',
  hours: 'Пн–Пт 10:00–19:00',
  phone: '+7 900 000-00-01',
};

function render(view: OrderView, cartReminder: CartReminder | null = null): string {
  return renderToStaticMarkup(
    createElement(OrderDetails, {
      view,
      pickup: PICKUP,
      contactPhone: PICKUP.phone,
      cartReminder,
    }),
  );
}

describe('loadOrderView', () => {
  it('loads items, totals, the promise date and the timeline by token', async () => {
    const order = await insertOrder({ checkoutAt: new Date('2026-10-02T09:05:00Z') });
    const view = await loadOrderView(db, order.token);
    expect(view).toMatchObject({
      id: order.id,
      number: order.number,
      token: order.token,
      status: 'awaiting_payment',
      statusLabel: 'Ждёт оплаты',
      scheme: 'prepay',
      fulfillment: 'pickup',
      promisedDate: '2026-10-08',
      promiseText: 'к чт 8 октября',
      subtotalKop: 222_600,
      courierFeeKop: 0,
      totalKop: 222_600,
      preferredChannel: 'max',
      pickupCode: null,
      canCancel: true,
      closed: false,
    });
    expect(view?.number).toMatch(/^DT-\d{6}$/);
    expect(view?.items).toEqual([
      expect.objectContaining({
        brand: 'Knecht',
        article: 'OC 90',
        qty: 2,
        priceClientKop: 52_800,
        lineTotalKop: 105_600,
        isLocal: true,
      }),
      expect.objectContaining({ brand: 'BOSCH', qty: 1, lineTotalKop: 117_000, isLocal: false }),
    ]);
    expect(view?.timeline).toEqual([
      expect.objectContaining({
        timeText: '2 октября, 14:05',
        text: 'Заказ оформлен, ждём оплату',
      }),
    ]);
    // the read model carries no personal data
    expect(JSON.stringify(view)).not.toContain(order.phone);
    expect(JSON.stringify(view)).not.toContain('Тест Тестов');
    expect(await findOrderNumber(db, order.token)).toBe(order.number);
  });

  it('returns null for an unknown or malformed token', async () => {
    expect(await loadOrderView(db, randomBytes(32).toString('base64url'))).toBeNull();
    expect(await loadOrderView(db, 'short')).toBeNull();
    expect(await loadOrderView(db, `${'a'.repeat(42)}'`)).toBeNull();
    expect(await findOrderNumber(db, 'short')).toBeNull();
  });

  it('pay_on_handover awaiting confirmation can be cancelled', async () => {
    const order = await insertOrder({ status: 'awaiting_confirmation' });
    const view = await loadOrderView(db, order.token);
    expect(view).toMatchObject({
      status: 'awaiting_confirmation',
      statusLabel: 'Ждёт подтверждения',
      scheme: 'pay_on_handover',
      canCancel: true,
    });
    expect(view?.timeline.map((e) => e.text)).toEqual(['Заказ оформлен, оплата при получении']);
  });

  it('shows the pickup code only at ready and offers no cancellation there', async () => {
    const ready = await loadOrderView(db, (await insertOrder({ status: 'ready' })).token);
    expect(ready).toMatchObject({
      pickupCode: '482913',
      canCancel: false,
      statusLabel: 'Готов к выдаче',
    });
    const confirmed = await loadOrderView(db, (await insertOrder({ status: 'confirmed' })).token);
    expect(confirmed).toMatchObject({ pickupCode: null, canCancel: false });
  });

  it('does not offer cancellation once the latest payment succeeded', async () => {
    const order = await insertOrder();
    await insertPayment(order.id, 'canceled', new Date('2026-10-02T09:06:00Z'));
    expect((await loadOrderView(db, order.token))?.canCancel).toBe(true);
    await insertPayment(order.id, 'succeeded', new Date('2026-10-02T09:10:00Z'));
    expect((await loadOrderView(db, order.token))?.canCancel).toBe(false);
  });
});

describe('order page rendering', () => {
  it('prepay: status, date, pickup point, inactive payment, items, timeline, cancel', async () => {
    const order = await insertOrder();
    const view = await loadOrderView(db, order.token);
    if (!view) throw new Error('view missing');
    const html = render(view);
    const text = plain(html);
    expect(text).toContain(`Заказ ${order.number}`);
    expect(text).toContain('Ждёт оплаты');
    expect(text).toContain('Получение к чт 8 октября');
    expect(text).toContain('Предоплата 100% онлайн');
    expect(text).toContain('Оплатить 2 226 ₽');
    expect(text).toContain('Оплата подключается — пришлём ссылку, как только она заработает');
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="pay-button"/);
    expect(text).toContain(PICKUP.address);
    expect(text).toContain(PICKUP.hours);
    expect(text).toContain(PICKUP.phone);
    expect(text).toContain('Knecht');
    expect(text).toContain('0 451 103 079');
    expect(text).toContain('2 × 528 ₽');
    expect(text).toContain('Итого 2 226 ₽');
    expect(text).toContain('Заказ оформлен, ждём оплату');
    expect(text).toContain('Статусы в MAX');
    expect(text).toContain('Статусы в Telegram');
    expect(html).toMatch(/data-testid="messenger-max" data-selected="true"/);
    expect(html).toMatch(/data-testid="messenger-telegram" data-selected="false"/);
    expect(text).toContain('Отменить заказ');
    expect(text).not.toContain('Код выдачи');
    // the client's phone and name never reach the page
    expect(text).not.toContain(order.phone);
    expect(text).not.toContain('Тест Тестов');
  });

  it('pay_on_handover and the cart reminder', async () => {
    const order = await insertOrder({
      status: 'awaiting_confirmation',
      preferredChannel: 'telegram',
    });
    const view = await loadOrderView(db, order.token);
    if (!view) throw new Error('view missing');
    const html = render(view, {
      text: 'В корзине остались детали под заказ — оформить второй заказ',
      href: '/checkout?part=order',
    });
    const text = plain(html);
    expect(text).toContain('Ждёт подтверждения');
    expect(text).toContain('Оплата при получении картой или по QR');
    expect(text).toContain('Подтверждение заказа подключается: мы свяжемся с вами');
    expect(text).not.toContain('Оплатить');
    expect(html).toMatch(/data-testid="messenger-telegram" data-selected="true"/);
    expect(html).toContain('href="/checkout?part=order"');
    expect(text).toContain('оформить второй заказ');
  });

  it('cancelled: no cancel button, no payment button, no messenger stubs', async () => {
    const order = await insertOrder({ status: 'cancelled' });
    const view = await loadOrderView(db, order.token);
    if (!view) throw new Error('view missing');
    const text = plain(render(view));
    expect(text).toContain('Отменён');
    expect(text).not.toContain('Отменить заказ');
    expect(text).not.toContain('Оплатить');
    expect(text).not.toContain('Статусы в MAX');
    expect(text).not.toContain('Получение к');
  });

  it('ready: shows the pickup code', async () => {
    const view = await loadOrderView(db, (await insertOrder({ status: 'ready' })).token);
    if (!view) throw new Error('view missing');
    expect(plain(render(view))).toContain('Код выдачи 482913');
  });
});

describe('/o/[token] page', () => {
  const saved = { ...process.env };

  beforeAll(() => {
    process.env.DATABASE_URL = webDatabaseUrl();
    process.env.REDIS_URL = testRedisUrl();
    process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
    resetEnvCache();
  });

  afterAll(async () => {
    const { getDb } = await import('@/server/db');
    await getDb().close();
    resetSingleton('db');
    process.env = saved;
    resetEnvCache();
  });

  async function notFoundDigest(token: string): Promise<string | undefined> {
    const { default: OrderPage } = await import('@/app/(site)/o/[token]/page');
    const error = await OrderPage({ params: Promise.resolve({ token }) }).catch((e: unknown) => e);
    return (error as { digest?: string } | undefined)?.digest;
  }

  it('answers notFound for a malformed and an unknown token', async () => {
    expect(await notFoundDigest('not-a-token')).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
    expect(await notFoundDigest(randomBytes(32).toString('base64url'))).toMatch(
      /^NEXT_HTTP_ERROR_FALLBACK;404/,
    );
  });

  it('metadata: noindex, no-referrer, title with the order number', async () => {
    const order = await insertOrder();
    const { generateMetadata } = await import('@/app/(site)/o/[token]/page');
    const meta = await generateMetadata({ params: Promise.resolve({ token: order.token }) });
    expect(meta).toMatchObject({
      title: `Заказ ${order.number}`,
      referrer: 'no-referrer',
      robots: { index: false, follow: false },
    });
    const unknown = await generateMetadata({ params: Promise.resolve({ token: 'bad' }) });
    expect(unknown).toMatchObject({ title: 'Заказ', referrer: 'no-referrer' });
  });
});

describe('POST /api/orders/<token>/cancel', () => {
  it('cancels awaiting_payment with the right digits through the state machine', async () => {
    const order = await insertOrder();
    const before = Date.now();
    const res = await cancel(order.token, { last4: order.last4 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'cancelled' });
    expect(res.headers.get('cache-control')).toBe('no-store');

    const row = await orderRow(order.id);
    expect(row.status).toBe('cancelled');
    expect(row.cancelledAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.expiresAt).toBeNull();
    const events = await eventsOf(order.id);
    expect(events.find((e) => e.type === 'client_cancelled')).toMatchObject({
      fromStatus: 'awaiting_payment',
      toStatus: 'cancelled',
      actorType: 'client',
      actorId: order.userId,
      payload: {},
    });

    const view = await loadOrderView(db, order.token);
    expect(view).toMatchObject({ status: 'cancelled', canCancel: false, closed: true });
    expect(view?.timeline.map((e) => e.text)).toEqual([
      'Заказ оформлен, ждём оплату',
      'Вы отменили заказ',
    ]);
  });

  it('cancels awaiting_confirmation and clears the confirmation deadline', async () => {
    const order = await insertOrder({
      status: 'awaiting_confirmation',
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    });
    const res = await cancel(order.token, { last4: order.last4 });
    expect(res.status).toBe(200);
    const row = await orderRow(order.id);
    expect(row).toMatchObject({ status: 'cancelled', expiresAt: null });
    expect(row.cancelledAt).toBeInstanceOf(Date);
    expect((await eventsOf(order.id)).map((e) => e.type)).toEqual(['checkout', 'client_cancelled']);
  });

  it('allows a prepay cancel while the latest payment is only pending', async () => {
    const order = await insertOrder();
    await insertPayment(order.id, 'pending');
    expect((await cancel(order.token, { last4: order.last4 })).status).toBe(200);
  });

  it('wrong digits five times: 422 with attemptsLeft, then 429 even for the right digits', async () => {
    const order = await insertOrder();
    const wrong = order.last4 === '0000' ? '1111' : '0000';
    const left: number[] = [];
    for (let i = 0; i < CANCEL_FAIL_LIMIT; i += 1) {
      const res = await cancel(order.token, { last4: wrong });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'wrong_digits' });
      left.push(res.body.attemptsLeft as number);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);

    const blocked = await cancel(order.token, { last4: order.last4 });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: 'too_many_attempts' });
    const retryAfter = Number(blocked.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(3500);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect((await orderRow(order.id)).status).toBe('awaiting_payment');
    expect(await redis.zcard(cancelFailKey(order.id, prefix))).toBe(CANCEL_FAIL_LIMIT);
  });

  it('the counter is per order: another order of the same client is not blocked', async () => {
    const first = await insertOrder();
    const second = await insertOrder({ phone: first.phone });
    const wrong = first.last4 === '0000' ? '1111' : '0000';
    for (let i = 0; i < CANCEL_FAIL_LIMIT; i += 1) await cancel(first.token, { last4: wrong });
    expect((await cancel(first.token, { last4: first.last4 })).status).toBe(429);
    expect((await cancel(second.token, { last4: second.last4 })).status).toBe(200);
  });

  it('409 not_cancellable for an already cancelled order', async () => {
    const order = await insertOrder({ status: 'cancelled' });
    const res = await cancel(order.token, { last4: order.last4 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'not_cancellable',
      message: 'Этот заказ уже нельзя отменить на сайте — позвоните нам',
    });
    expect(await eventsOf(order.id)).toHaveLength(1);
  });

  it('409 not_cancellable when the latest payment succeeded (and while it awaits capture)', async () => {
    for (const status of ['succeeded', 'waiting_for_capture'] as const) {
      const order = await insertOrder();
      await insertPayment(order.id, status);
      const res = await cancel(order.token, { last4: order.last4 });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'not_cancellable' });
      const row = await orderRow(order.id);
      expect(row).toMatchObject({ status: 'awaiting_payment', cancelledAt: null });
      expect((await eventsOf(order.id)).map((e) => e.type)).toEqual(['checkout']);
    }
  });

  it('409 after confirmation: client_cancelled does not apply (client_refused is 1B)', async () => {
    const order = await insertOrder({ status: 'confirmed', scheme: 'pay_on_handover' });
    expect((await cancel(order.token, { last4: order.last4 })).status).toBe(409);
  });

  it('two simultaneous cancels: one succeeds, the other gets 409 (row lock)', async () => {
    const order = await insertOrder();
    const results = await Promise.all([
      cancel(order.token, { last4: order.last4 }),
      cancel(order.token, { last4: order.last4 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const cancelled = (await eventsOf(order.id)).filter((e) => e.type === 'client_cancelled');
    expect(cancelled).toHaveLength(1);
  });

  it('403 for a foreign Origin or without Origin and Sec-Fetch-Site', async () => {
    const order = await insertOrder();
    const foreign = await cancel(
      order.token,
      { last4: order.last4 },
      { Origin: 'https://evil.example' },
    );
    expect(foreign.status).toBe(403);
    expect(foreign.body).toMatchObject({ error: 'forbidden_origin' });
    expect((await cancel(order.token, { last4: order.last4 }, {})).status).toBe(403);
    expect(
      (await cancel(order.token, { last4: order.last4 }, { 'Sec-Fetch-Site': 'cross-site' }))
        .status,
    ).toBe(403);
    expect((await orderRow(order.id)).status).toBe('awaiting_payment');
    // same-origin fetch without Origin passes
    expect(
      (await cancel(order.token, { last4: order.last4 }, { 'Sec-Fetch-Site': 'same-origin' }))
        .status,
    ).toBe(200);
  });

  it('404 for an unknown or malformed token', async () => {
    const unknown = await cancel(randomBytes(32).toString('base64url'), { last4: '1234' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: 'not_found' });
    expect((await cancel('not-a-token', { last4: '1234' })).status).toBe(404);
  });

  it('400/422 for a bad body; such requests do not count as attempts', async () => {
    const order = await insertOrder();
    expect((await cancel(order.token, 'not json')).status).toBe(400);
    expect((await cancel(order.token, [order.last4])).status).toBe(400);
    for (const last4 of ['12a4', '123', '12345', 1234, null]) {
      const res = await cancel(order.token, { last4 });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ error: 'validation' });
    }
    expect(await redis.exists(cancelFailKey(order.id, prefix))).toBe(0);
    expect((await orderRow(order.id)).status).toBe('awaiting_payment');
  });

  it('503 when Redis is unavailable (fail closed), nothing changes', async () => {
    const order = await insertOrder();
    const down = createRedis('redis://127.0.0.1:1/0', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    try {
      const response = await handleCancelRequest(
        cancelRequest(order.token, { last4: order.last4 }),
        order.token,
        deps({ redis: down }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'unavailable' });
      expect((await orderRow(order.id)).status).toBe('awaiting_payment');
    } finally {
      down.disconnect();
    }
  });

  it('logs the order number only, never the phone, the digits or the token', async () => {
    const order = await insertOrder();
    const lines: unknown[] = [];
    const logger = {
      info: (...args: unknown[]) => lines.push(args),
      warn: (...args: unknown[]) => lines.push(args),
      error: (...args: unknown[]) => lines.push(args),
    } as unknown as CancelHandlerDeps['logger'];
    const wrong = order.last4 === '0000' ? '1111' : '0000';
    await handleCancelRequest(
      cancelRequest(order.token, { last4: wrong }),
      order.token,
      deps({ logger }),
    );
    await handleCancelRequest(
      cancelRequest(order.token, { last4: order.last4 }),
      order.token,
      deps({ logger }),
    );
    const logged = JSON.stringify(lines);
    expect(logged).toContain(order.number);
    expect(logged).not.toContain(order.phone);
    expect(logged).not.toContain(order.token);
    expect(logged).not.toMatch(/last4/i);
    expect(logged).not.toContain(`"${order.last4}"`);
    expect(logged).not.toContain(`"${wrong}"`);
  });
});
