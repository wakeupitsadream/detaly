// Shared fixtures of the payments, receipts and reconciliation tests (worker-payments package):
// the msw emulation of YooKassa, WorkerDeps with the YooKassa adapter and a controllable clock,
// an order factory on the `_worker` database, the real online payment flow (preparePayment →
// POST /payments → recordPaymentCreated), stored webhooks and a small outbox runner standing
// in for the dispatcher of worker-core.
import { randomBytes, randomInt } from 'node:crypto';
import {
  and,
  asc,
  eq,
  isNull,
  orderEvents,
  orderItems,
  orders,
  outbox,
  sql,
  users,
  webhookEvents,
  type Db,
} from '@detaly/db';
import type { OrderItemState, OrderStatus, PaymentScheme } from '@detaly/domain';
import { preparePayment, recordPaymentCreated } from '@detaly/orders';
import { createYooKassaProvider } from '@detaly/payments';
import { createYooKassaMock, type YooKassaMock } from '@detaly/payments/testing';
import type { Job } from 'bullmq';
import { getResponse } from 'msw';
import { expect } from 'vitest';
import type { WorkerDeps } from '../src/deps';
import { processPayments } from '../src/jobs/payments';
import { processReceipts } from '../src/jobs/receipts';
import { createTestDeps, type TestDeps, type TestDepsOverrides } from './helpers/test-deps';

export const SHOP = { shopId: 'test-shop', secretKey: 'test-secret' } as const;

/** Decision Б6: the four variables that switch payments on. */
export const PAYMENT_ENV = {
  YOOKASSA_SHOP_ID: SHOP.shopId,
  YOOKASSA_SECRET_KEY: SHOP.secretKey,
  YOOKASSA_VAT_CODE: '1',
  YOOKASSA_TAX_SYSTEM_CODE: '2',
  APP_BASE_URL: 'https://detaly.test',
};

export interface TestClock {
  now: Date;
  advance(ms: number): void;
}

/** Starts at the real time: rows the database stamps with now() stay comparable. */
export function testClock(start: Date = new Date()): TestClock {
  const clock: TestClock = {
    now: new Date(start),
    advance(ms) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  return clock;
}

export const MINUTE = 60_000;

/**
 * One emulated YooKassa per test file. Requests reach the msw handlers through the adapter's
 * injected `fetch` (msw `getResponse`), not through setupServer: msw 3 intercepts every
 * socket in the process, which breaks the PostgreSQL and Redis connections of these tests.
 */
export function yooKassa(clock?: () => TestClock): {
  mock: YooKassaMock;
  fetch: typeof fetch;
  /**
   * The next request to `METHOD /path` (e.g. `POST /refunds`) is processed by the emulation,
   * but its 200 answer is unreadable (a proxy page): the adapter reports `bad_response`.
   */
  garbleNext(path: string): void;
} {
  const mock = createYooKassaMock({
    ...SHOP,
    now: clock ? () => clock().now : undefined,
  });
  const garbled: string[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const key = `${request.method} ${new URL(request.url).pathname.replace(/^\/v3/u, '')}`;
    const response = await getResponse(mock.handlers, request);
    if (response === undefined) throw new Error(`unhandled YooKassa request ${request.url}`);
    // HttpResponse.error(): a connection failure, as fetch reports it.
    if (response.type === 'error') throw new TypeError('fetch failed');
    const index = garbled.indexOf(key);
    if (index !== -1 && response.ok) {
      garbled.splice(index, 1);
      return new Response('<html>502 Bad Gateway</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return response;
  };
  return {
    mock,
    fetch: mockFetch,
    garbleNext(path) {
      garbled.push(path);
    },
  };
}

export interface PaymentTestDeps extends TestDeps {
  clock: TestClock;
}

export async function paymentTestDeps(
  overrides: TestDepsOverrides & { clock?: TestClock; fetch: typeof fetch },
): Promise<PaymentTestDeps> {
  const { clock = testClock(), envOverrides, fetch: mockFetch, ...rest } = overrides;
  const provider = createYooKassaProvider({ ...SHOP, timeoutMs: 5_000, fetch: mockFetch });
  const t = await createTestDeps({
    envOverrides: { ...PAYMENT_ENV, ...envOverrides },
    payments: provider,
    receipts: provider,
    now: () => clock.now,
    ...rest,
  });
  return { ...t, clock };
}

export function job(name: string, data: Record<string, unknown>): Job {
  return { name, data } as unknown as Job;
}

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

export interface SeedOptions {
  scheme?: PaymentScheme;
  status?: OrderStatus;
  itemState?: OrderItemState;
  /** Prices of the items (kopecks), one item each. */
  prices?: number[];
  clientArrived?: boolean;
}

export interface Seeded {
  orderId: string;
  number: string;
  itemIds: string[];
  totalKop: number;
  phone: string;
  userId: string;
}

export function randomPhone(): string {
  return `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

/** A user and an order with items, inserted directly in a status (no payment). */
export async function seedOrder(db: Db, options: SeedOptions = {}): Promise<Seeded> {
  const scheme = options.scheme ?? 'prepay';
  const status = options.status ?? 'awaiting_payment';
  const prices = options.prices ?? [128_000, 64_000];
  const phone = randomPhone();
  const totalKop = prices.reduce((sum, price) => sum + price, 0);
  const [user] = await db.insert(users).values({ phone }).returning({ id: users.id });
  const userId = (user as { id: string }).id;
  const [order] = await db
    .insert(orders)
    .values({
      userId,
      accessToken: randomBytes(32).toString('base64url'),
      status,
      paymentScheme: scheme,
      subtotalKop: totalKop,
      courierFeeKop: 0,
      totalKop,
      itemsHash: 'test',
      clientArrivedAt: options.clientArrived ? new Date() : null,
    })
    .returning({ id: orders.id, number: orders.number });
  const { id: orderId, number } = order as { id: string; number: string };
  const itemIds: string[] = [];
  for (const [i, price] of prices.entries()) {
    const brand = i === 0 ? 'MANN' : `BRAND${i}`;
    const article = `W 914/${i + 2}`;
    const articleNorm = article.replace(/[^A-Z0-9]/gu, '');
    const [item] = await db
      .insert(orderItems)
      .values({
        orderId,
        offerKey: `${articleNorm}:${brand}:ORB1`,
        searchArticleNorm: articleNorm,
        brand,
        article,
        name: 'Фильтр масляный',
        qty: 1,
        stockId: 'ORB1',
        isLocal: true,
        priceSupplierAtOrderKop: Math.round(price / 1.28),
        priceClientKop: price,
        markupBp: 2800,
        etaDate: '2026-10-08',
        offerSnapshot: {
          source: 'rossko',
          brand,
          article,
          articleNorm,
          name: 'Фильтр масляный',
          group: null,
          isCross: false,
          priceSupplierKop: Math.round(price / 1.28),
          stock: {
            stockId: 'ORB1',
            isLocal: true,
            count: 4,
            multiplicity: 1,
            type: null,
            deliveryDays: 2,
            deliveryStart: null,
            deliveryEnd: null,
            extra: null,
            description: null,
          },
        },
        state: options.itemState ?? 'pending',
      })
      .returning({ id: orderItems.id });
    itemIds.push((item as { id: string }).id);
  }
  return { orderId, number, itemIds, totalKop, phone, userId };
}

/** Test setup only: puts the order (and its live items) into a state without a transition. */
export async function forceState(
  db: Db,
  orderId: string,
  input: { status: OrderStatus; itemState?: OrderItemState; clientArrived?: boolean },
): Promise<void> {
  await db
    .update(orders)
    .set({
      status: input.status,
      ...(input.clientArrived !== undefined
        ? { clientArrivedAt: input.clientArrived ? new Date() : null }
        : {}),
      ...(input.status === 'ready' ? { receivedAt: new Date() } : {}),
    })
    .where(eq(orders.id, orderId));
  if (input.itemState) {
    await db
      .update(orderItems)
      .set({ state: input.itemState })
      .where(eq(orderItems.orderId, orderId));
  }
}

export async function orderRow(db: Db, orderId: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!row) throw new Error('order not found');
  return row;
}

export async function eventsOf(db: Db, orderId: string) {
  return db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(asc(orderEvents.createdAt), asc(orderEvents.id));
}

export async function outboxOf(db: Db, orderId: string) {
  return db
    .select()
    .from(outbox)
    .where(sql`${outbox.data}->>'orderId' = ${orderId}`)
    .orderBy(asc(outbox.createdAt), asc(outbox.id));
}

// ---------------------------------------------------------------------------------------------
// Payments and webhooks
// ---------------------------------------------------------------------------------------------

/** The web flow of «Оплатить N ₽» (decision Б5): rows, POST /payments, the recorded answer. */
export async function createOnlinePayment(
  t: PaymentTestDeps,
  orderId: string,
): Promise<{ paymentRowId: string; providerPaymentId: string }> {
  const prepared = await preparePayment(t.deps.engine, {
    orderId,
    kind: 'prepayment',
    confirmation: 'redirect',
    returnUrl: 'https://detaly.test/o/token?paid=1',
  });
  if (prepared.kind !== 'create') throw new Error(`preparePayment: ${prepared.kind}`);
  const provider = t.deps.payments as NonNullable<WorkerDeps['payments']>;
  const created = await provider.createPayment(prepared.request);
  await recordPaymentCreated(t.deps.engine, prepared.paymentRowId, created);
  return { paymentRowId: prepared.paymentRowId, providerPaymentId: created.id };
}

/** What POST /api/webhooks/yookassa stores (section 14.3); returns the webhook_events id. */
export async function storeWebhook(db: Db, body: Record<string, unknown>): Promise<string> {
  const object = body.object as { id: string };
  const [row] = await db
    .insert(webhookEvents)
    .values({
      source: 'yookassa',
      externalId: object.id,
      eventType: String(body.event),
      payload: body,
      ip: '185.71.76.1',
    })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (row) return row.id;
  const [existing] = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.source, 'yookassa'),
        eq(webhookEvents.externalId, object.id),
        eq(webhookEvents.eventType, String(body.event)),
      ),
    );
  return (existing as { id: string }).id;
}

export async function deliverWebhook(
  t: PaymentTestDeps,
  mock: YooKassaMock,
  event: string,
  objectId: string,
): Promise<{ webhookEventId: string; result: unknown }> {
  const webhookEventId = await storeWebhook(t.deps.db, mock.notification(event, objectId));
  const result = await processPayments(job('webhook', { webhookEventId }), t.deps);
  return { webhookEventId, result };
}

/** A prepay order paid online: awaiting_payment → confirmed through the webhook job. */
export async function paidPrepayOrder(
  t: PaymentTestDeps,
  mock: YooKassaMock,
  options: SeedOptions = {},
): Promise<Seeded & { paymentRowId: string; providerPaymentId: string }> {
  const seeded = await seedOrder(t.deps.db, options);
  const payment = await createOnlinePayment(t, seeded.orderId);
  mock.setPaymentStatus(payment.providerPaymentId, 'succeeded');
  await deliverWebhook(t, mock, 'payment.succeeded', payment.providerPaymentId);
  expect((await orderRow(t.deps.db, seeded.orderId)).status).toBe('confirmed');
  return { ...seeded, ...payment };
}

// ---------------------------------------------------------------------------------------------
// Outbox runner (stand-in for the worker-core dispatcher)
// ---------------------------------------------------------------------------------------------

const PROCESSORS = { payments: processPayments, receipts: processReceipts } as const;

/**
 * Runs the order's undispatched outbox rows of the payments/receipts queues that are due by the
 * test clock (or the database clock) (optionally one job name), marking them dispatched first like the dispatcher does.
 */
export async function runOutbox(
  t: PaymentTestDeps,
  orderId: string,
  filter: { queue: keyof typeof PROCESSORS; name?: string },
): Promise<unknown[]> {
  const rows = await t.deps.db
    .select()
    .from(outbox)
    .where(
      and(
        isNull(outbox.dispatchedAt),
        eq(outbox.queue, filter.queue),
        filter.name ? eq(outbox.name, filter.name) : undefined,
        sql`${outbox.data}->>'orderId' = ${orderId}`,
        // Rows the engine wrote are stamped with now() of the database.
        sql`${outbox.availableAt} <= greatest(now(), ${t.clock.now.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(asc(outbox.createdAt), asc(outbox.id));
  const results: unknown[] = [];
  for (const row of rows) {
    await t.deps.db.update(outbox).set({ dispatchedAt: t.clock.now }).where(eq(outbox.id, row.id));
    results.push(
      await PROCESSORS[filter.queue](job(row.name, { ...row.data, outboxKey: row.jobId }), t.deps),
    );
  }
  return results;
}

/** Phone digits never appear in journal payloads or outbox data (PD minimisation). */
export function expectNoPhone(value: unknown, phone: string): void {
  const text = JSON.stringify(value);
  expect(text.includes(phone)).toBe(false);
  expect(text.includes(phone.replace(/^\+/u, ''))).toBe(false);
}
