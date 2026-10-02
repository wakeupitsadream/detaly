// POST /api/orders/<token>/actions (section 14.2, decision Б24) and the decision blocks of
// /o/<token> (14.4) against local PG and Redis: «Подтверждаю», «Согласен», «Вернуть деньги»,
// «Отказаться от заказа», «Отменить позицию», «Оплатить заранее». Orders are inserted directly
// in the state each case needs; Redis keys live under test:<uuid>:.
import { randomBytes, randomInt } from 'node:crypto';
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import {
  asc,
  clientApprovals,
  createDb,
  eq,
  orderEvents,
  orderItems,
  orders,
  outbox,
  payments,
  refunds,
  sql,
  users,
  type Db,
} from '@detaly/db';
import type {
  ApprovalProposal,
  Offer,
  OrderItemState,
  OrderStatus,
  PaymentScheme,
} from '@detaly/domain';
import type { EngineDeps } from '@detaly/orders';
import type * as Navigation from 'next/navigation';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderDetails } from '@/components/order/OrderDetails';
import { actionErrorText } from '@/components/order/ClientActionForm';
import { handleOrderAction, type ActionsHandlerDeps } from '@/server/orders/actions-handler';
import { handleCancelRequest } from '@/server/orders/cancel-handler';
import { DIGITS_FAIL_LIMIT } from '@/server/orders/digits';
import { loadOrderView, type OrderView } from '@/server/orders/order-view';
import { parsePayNotice } from '@/server/orders/pay-notice';
import { intEnv, webDatabaseUrl } from './helpers';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const APP = 'http://127.0.0.1:3100';
const prefix = testKeyPrefix();
// Receipt codes are needed for refund receipts; payments themselves are not called here.
const env = intEnv({
  APP_BASE_URL: APP,
  YOOKASSA_SHOP_ID: 'test-shop',
  YOOKASSA_SECRET_KEY: 'test-secret',
  YOOKASSA_VAT_CODE: '1',
  YOOKASSA_TAX_SYSTEM_CODE: '2',
});
let db: Db;
let redis: Redis;
let nudges = 0;
let logs: { level: string; details: unknown; message: string }[] = [];

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 4 });
  redis = createRedis(testRedisUrl());
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
  await db.close();
});

beforeEach(() => {
  logs = [];
  nudges = 0;
});

const logger = {
  info: (details: unknown, message: string) => logs.push({ level: 'info', details, message }),
  warn: (details: unknown, message: string) => logs.push({ level: 'warn', details, message }),
  error: (details: unknown, message: string) => logs.push({ level: 'error', details, message }),
} as unknown as NonNullable<ActionsHandlerDeps['logger']>;

function engine(): EngineDeps {
  return {
    db,
    env,
    nudge: () => {
      nudges += 1;
    },
  };
}

function deps(): ActionsHandlerDeps {
  return { engine: engine(), redis, keyPrefix: prefix, appBaseUrl: APP, logger };
}

function offer(brand: string, article: string, isLocal: boolean): Offer {
  return {
    source: 'rossko',
    brand,
    article,
    articleNorm: article.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
    name: 'Фильтр масляный',
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

interface SeedOptions {
  status: OrderStatus;
  scheme?: PaymentScheme;
  /** States of the two items (Knecht OC 90 ×2, BOSCH 0 451 103 079 ×1). */
  states?: [OrderItemState, OrderItemState];
  /** A succeeded prepayment of the whole total. */
  paid?: boolean;
  approval?: { proposal: ApprovalProposal; itemIndex?: 0 | 1; expiresAt?: Date | null };
}

interface Seeded {
  id: string;
  token: string;
  number: string;
  userId: string;
  phone: string;
  last4: string;
  itemIds: [string, string];
}

const TOTAL = 2 * 52_800 + 117_000;

async function seed({
  status,
  scheme = 'prepay',
  states = ['ordered', 'ordered'],
  paid = scheme === 'prepay' && !['awaiting_payment', 'draft'].includes(status),
  approval,
}: SeedOptions): Promise<Seeded> {
  const phone = `+79${randomInt(100_000_000, 1_000_000_000)}`;
  const [user] = await db.insert(users).values({ phone, name: 'Решение Тестов' }).returning();
  if (!user) throw new Error('user not inserted');
  const token = randomBytes(32).toString('base64url');
  const [order] = await db
    .insert(orders)
    .values({
      userId: user.id,
      accessToken: token,
      status,
      paymentScheme: scheme,
      subtotalKop: TOTAL,
      totalKop: TOTAL,
      itemsHash: 'test',
      promisedDate: '2026-10-08',
      pickupCode: '482913',
      receivedAt: status === 'ready' ? new Date() : null,
      expiresAt: status === 'ready' ? new Date(Date.now() + 7 * 86_400_000) : null,
    })
    .returning();
  if (!order) throw new Error('order not inserted');
  const items = await db
    .insert(orderItems)
    .values([
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
        offerSnapshot: offer('Knecht', 'OC 90', true),
        state: states[0],
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
        offerSnapshot: offer('BOSCH', '0 451 103 079', false),
        state: states[1],
        createdAt: new Date('2026-10-02T09:05:01Z'),
      },
    ])
    .returning({ id: orderItems.id });
  const itemIds = [items[0]?.id ?? '', items[1]?.id ?? ''] as [string, string];
  if (paid) {
    await db.insert(payments).values({
      orderId: order.id,
      kind: 'prepayment',
      status: 'succeeded',
      amountKop: TOTAL,
      providerPaymentId: `pay-${randomBytes(6).toString('hex')}`,
      idempotenceKey: randomBytes(16).toString('hex'),
      paidAt: new Date(),
    });
  }
  if (approval) {
    const itemId = approval.itemIndex === undefined ? null : itemIds[approval.itemIndex];
    await db.insert(clientApprovals).values({
      orderId: order.id,
      orderItemId: itemId,
      kind: approval.proposal.kind,
      scope: itemId === null ? 'order' : 'item',
      proposal: approval.proposal,
      notifiedAt: new Date(),
      expiresAt:
        approval.expiresAt === undefined ? new Date('2026-10-03T09:05:00Z') : approval.expiresAt,
    });
  }
  return {
    id: order.id,
    token,
    number: order.number,
    userId: user.id,
    phone,
    last4: phone.slice(-4),
    itemIds,
  };
}

function wrongDigits(order: Seeded): string {
  return order.last4 === '0000' ? '1111' : '0000';
}

async function act(
  token: string,
  body: unknown,
  headers: Record<string, string> = { Origin: APP },
) {
  const response = await handleOrderAction(
    new Request(`${APP}/api/orders/${token}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    token,
    deps(),
  );
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as Record<string, unknown>,
  };
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

async function viewOf(token: string): Promise<OrderView> {
  const view = await loadOrderView(db, token, { env, paymentsEnabled: true });
  if (!view) throw new Error('view missing');
  return view;
}

function render(view: OrderView): string {
  return renderToStaticMarkup(
    createElement(OrderDetails, {
      view,
      pickup: { name: null, address: 'г. Оренбург, ул. Тестовая, 1', hours: null, phone: null },
      contactPhone: null,
      cartReminder: null,
      notice: parsePayNotice({}),
    }),
  );
}

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const NEW_ETA: ApprovalProposal = { kind: 'new_eta', etaDate: '2099-10-20', note: null };

function alternative(): ApprovalProposal {
  return {
    kind: 'alternative',
    offer: offer('MANN', 'W 914/2', false),
    priceClientKop: 117_000,
    priceSupplierKop: 80_000,
    markupBp: 2800,
    etaDate: '2099-10-09',
    searchArticleNorm: 'OC90',
    offerKey: 'W9142:MANN:MSK7',
    marginBp: 3100,
  };
}

describe('POST /api/orders/<token>/actions: checks', () => {
  it('403 without the site Origin, 404 for a bad token, 400/422 for a bad body', async () => {
    const order = await seed({ status: 'awaiting_confirmation', scheme: 'pay_on_handover' });
    expect(
      (await act(order.token, { action: 'confirm' }, { Origin: 'https://evil.test' })).status,
    ).toBe(403);
    expect((await act(order.token, { action: 'confirm' }, {})).status).toBe(403);
    expect((await act('short', { action: 'confirm' })).status).toBe(404);
    expect((await act(randomBytes(32).toString('base64url'), { action: 'confirm' })).status).toBe(
      404,
    );
    expect((await act(order.token, 'not json')).status).toBe(400);
    expect((await act(order.token, [1])).status).toBe(400);
    expect((await act(order.token, { action: 'explode' })).status).toBe(422);
    const noDigits = await act(order.token, { action: 'refuse' });
    expect(noDigits.status).toBe(422);
    expect(noDigits.body.message).toBe('Введите последние 4 цифры телефона');
    expect((await act(order.token, { action: 'item_cancel', last4: order.last4 })).status).toBe(
      422,
    );
    expect((await orderRow(order.id)).status).toBe('awaiting_confirmation');
  });

  it('409 not_allowed when the state machine refuses (no open approval)', async () => {
    const order = await seed({ status: 'confirmed' });
    const res = await act(order.token, { action: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'not_allowed', status: 'confirmed' });
    expect((await orderRow(order.id)).status).toBe('confirmed');
  });
});

describe('«Подтверждаю» (pay on handover)', () => {
  it('confirms through the engine: journal, seller notification in the outbox, nudge', async () => {
    const order = await seed({
      status: 'awaiting_confirmation',
      scheme: 'pay_on_handover',
      states: ['pending', 'pending'],
    });
    const before = await viewOf(order.token);
    expect(before.actions.confirm).toBe(true);
    expect(plain(render(before))).toContain('Подтверждаю');

    const res = await act(order.token, { action: 'confirm' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'confirmed' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const row = await orderRow(order.id);
    expect(row.status).toBe('confirmed');
    expect(row.confirmedAt).toBeInstanceOf(Date);
    const event = (await eventsOf(order.id)).find((e) => e.type === 'client_confirmed');
    expect(event).toMatchObject({ actorType: 'client', actorId: order.userId });
    const queued = await db
      .select()
      .from(outbox)
      .where(sql`${outbox.jobId} like ${`notify:${event?.id}:%`}`);
    expect(queued.length).toBeGreaterThan(0);
    expect(nudges).toBe(1);

    const after = await viewOf(order.token);
    expect(after.actions.confirm).toBe(false);
    expect(after.timeline.map((e) => e.text)).toContain('Вы подтвердили заказ');
    // Repeating it is a 409, nothing new is written.
    expect((await act(order.token, { action: 'confirm' })).status).toBe(409);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(order.token);
    expect(text).not.toContain(order.phone);
  });
});

describe('«Согласен» / «Вернуть деньги» on an open approval', () => {
  it('the page shows the proposal, the deadline and both buttons', async () => {
    const order = await seed({
      status: 'awaiting_client_approval',
      approval: { proposal: alternative(), itemIndex: 1 },
    });
    const view = await viewOf(order.token);
    expect(view.actions).toMatchObject({ approve: true, refundRequest: true, refuse: true });
    expect(view.approval).toMatchObject({
      kind: 'alternative',
      scope: 'item',
      item: { brand: 'BOSCH', article: '0 451 103 079' },
      alternative: { brand: 'MANN', article: 'W 914/2' },
      deadlineText: '3 октября, 14:05',
      refundsWholeOrder: false,
    });
    const html = render(view);
    const text = plain(html);
    expect(text).toContain('Нужно ваше решение');
    expect(text).toContain('Позицию BOSCH 0 451 103 079 поставщик привезти не может');
    expect(text).toContain('MANN W 914/2');
    expect(text).toContain('Ответьте до 3 октября, 14:05');
    expect(html).toContain('data-testid="order-approve-open"');
    expect(html).toContain('data-testid="order-refund-request-open"');
    expect(text).toContain('Вернуть деньги');
    expect(html).not.toContain(order.phone);
  });

  it('«Согласен» on a new date: back to the supplier order, the approval is decided', async () => {
    const order = await seed({
      status: 'awaiting_client_approval',
      approval: { proposal: NEW_ETA },
    });
    const res = await act(order.token, { action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ordered_at_supplier' });
    const [approval] = await db
      .select()
      .from(clientApprovals)
      .where(eq(clientApprovals.orderId, order.id));
    expect(approval).toMatchObject({ decision: 'approved' });
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    expect(items.map((i) => i.etaDate)).toEqual(['2099-10-20', '2099-10-20']);
    expect((await viewOf(order.token)).timeline.map((e) => e.text)).toContain(
      'Вы согласились с предложением',
    );
  });

  it('«Вернуть деньги» with wrong digits: 422 with attempts left, nothing changes; right digits refund', async () => {
    const order = await seed({
      status: 'awaiting_client_approval',
      approval: { proposal: NEW_ETA },
    });
    const wrong = await act(order.token, { action: 'refund_request', last4: wrongDigits(order) });
    expect(wrong.status).toBe(422);
    expect(wrong.body).toMatchObject({
      error: 'wrong_digits',
      attemptsLeft: DIGITS_FAIL_LIMIT - 1,
    });
    expect(actionErrorText(422, wrong.body)).toContain('Осталось попыток: 4');
    expect((await orderRow(order.id)).status).toBe('awaiting_client_approval');

    const before = Date.now();
    const ok = await act(order.token, { action: 'refund_request', last4: order.last4 });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'refund_pending' });
    const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, order.id));
    expect(refund).toMatchObject({ status: 'pending', scope: 'order', amountKop: TOTAL });
    expect(refund?.deadlineAt.getTime()).toBeGreaterThanOrEqual(before + 10 * 86_400_000 - 1000);
    const queued = await db
      .select()
      .from(outbox)
      .where(eq(outbox.jobId, `refund-create:${refund?.id}`));
    expect(queued).toHaveLength(1);

    const view = await viewOf(order.token);
    expect(view.refund).toMatchObject({ pendingKop: TOTAL, sentKop: 0 });
    const text = plain(render(view));
    expect(text).toContain('Возвращаем 2 226 ₽');
    expect(text).toMatch(/Деньги вернутся до \d{1,2} [а-я]+/);
    expect(view.timeline.map((e) => e.text)).toContain('Вы выбрали возврат денег');
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(order.phone);
    expect(logged).not.toContain(order.token);
    expect(logged).not.toContain(`"${order.last4}"`);
  });
});

describe('«Отказаться от заказа»', () => {
  it('prepay paid: digits, then refund_pending with a whole-order refund', async () => {
    const order = await seed({ status: 'ordered_at_supplier' });
    const view = await viewOf(order.token);
    expect(view.actions.refuse).toBe(true);
    expect(view.moneyHeld).toBe(true);
    expect(plain(render(view))).toContain('Деньги вернём в течение 10 дней');
    expect((await act(order.token, { action: 'refuse', last4: wrongDigits(order) })).status).toBe(
      422,
    );
    const res = await act(order.token, { action: 'refuse', last4: order.last4 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'refund_pending' });
    expect(await db.select().from(refunds).where(eq(refunds.orderId, order.id))).toHaveLength(1);
    const after = await viewOf(order.token);
    expect(after.actions.refuse).toBe(false);
    expect(after.timeline.map((e) => e.text)).toContain(
      'Вы отказались от заказа — возвращаем деньги',
    );
  });

  it('pay on handover without payment: cancelled, «оплаты не было»', async () => {
    const order = await seed({
      status: 'confirmed',
      scheme: 'pay_on_handover',
      states: ['pending', 'pending'],
    });
    const view = await viewOf(order.token);
    expect(view.moneyHeld).toBe(false);
    expect(plain(render(view))).toContain('Оплаты не было — возвращать нечего');
    const res = await act(order.token, { action: 'refuse', last4: order.last4 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'cancelled' });
    expect(await db.select().from(refunds).where(eq(refunds.orderId, order.id))).toHaveLength(0);
  });

  it('not offered after handover', async () => {
    const order = await seed({ status: 'handed', states: ['handed', 'handed'] });
    expect((await viewOf(order.token)).actions.refuse).toBe(false);
    expect((await act(order.token, { action: 'refuse', last4: order.last4 })).status).toBe(409);
  });
});

describe('partial arrival: «Жду до» and «Отменить позицию»', () => {
  it('shows the wait text and cancels only the item that has not arrived', async () => {
    const order = await seed({ status: 'ordered_at_supplier', states: ['arrived', 'ordered'] });
    const view = await viewOf(order.token);
    expect(view.partialArrival).toEqual({ waitUntilText: 'чт 8 октября' });
    expect(view.items.map((i) => i.canCancel)).toEqual([false, true]);
    const html = render(view);
    expect(plain(html)).toContain('Жду до чт 8 октября');
    expect(html).toContain(`data-testid="order-item-cancel-${order.itemIds[1]}-open"`);
    expect(html).not.toContain(`order-item-cancel-${order.itemIds[0]}`);

    const arrived = await act(order.token, {
      action: 'item_cancel',
      itemId: order.itemIds[0],
      last4: order.last4,
    });
    expect(arrived.status).toBe(409);
    const foreign = await act(order.token, {
      action: 'item_cancel',
      itemId: '0192f0c4-0000-7000-8000-000000000001',
      last4: order.last4,
    });
    expect(foreign.status).toBe(409);

    const res = await act(order.token, {
      action: 'item_cancel',
      itemId: order.itemIds[1],
      last4: order.last4,
    });
    expect(res.status).toBe(200);
    // Everything left has arrived: the order is ready, the item's money goes back.
    expect(res.body).toEqual({ status: 'ready' });
    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.createdAt));
    expect(items.map((i) => i.state)).toEqual(['arrived', 'refund_pending']);
    const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, order.id));
    expect(refund).toMatchObject({ scope: 'item', amountKop: 117_000 });
    const after = await viewOf(order.token);
    expect(after.partialArrival).toBeNull();
    expect(after.items[1]).toMatchObject({ inactive: true, stateLabel: 'Возвращаем деньги' });
    expect(after.timeline.map((e) => e.text)).toContain('Вы отменили позицию: BOSCH 0 451 103 079');
  });
});

describe('«Оплатить заранее»', () => {
  it('ready pay-on-handover order switches to prepay and waits for payment', async () => {
    const order = await seed({
      status: 'ready',
      scheme: 'pay_on_handover',
      states: ['arrived', 'arrived'],
    });
    const view = await viewOf(order.token);
    expect(view.actions.prepayNow).toBe(true);
    expect(view.pickupCode).toBe('482913');
    expect(plain(render(view))).toContain('Оплатить заранее');
    const res = await act(order.token, { action: 'prepay_now' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'awaiting_payment' });
    const row = await orderRow(order.id);
    expect(row).toMatchObject({ status: 'awaiting_payment', paymentScheme: 'prepay' });
    expect(row.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    const after = await viewOf(order.token);
    expect(after.actions.pay).toBe(true);
    expect(render(after)).toContain('data-testid="pay-button"');
  });

  it('is not offered without online payments', async () => {
    const order = await seed({
      status: 'ready',
      scheme: 'pay_on_handover',
      states: ['arrived', 'arrived'],
    });
    const view = await loadOrderView(db, order.token, { env, paymentsEnabled: false });
    expect(view?.actions.prepayNow).toBe(false);
  });
});

describe('the digit counter is shared with the 1A cancellation', () => {
  it('failures of cancel and actions add up; then 429 even for the right digits', async () => {
    const order = await seed({ status: 'ordered_at_supplier' });
    const wrong = wrongDigits(order);
    for (let i = 0; i < 2; i += 1) {
      expect((await act(order.token, { action: 'refuse', last4: wrong })).status).toBe(422);
    }
    for (let i = 0; i < 3; i += 1) {
      const res = await handleCancelRequest(
        new Request(`${APP}/api/orders/${order.token}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: APP },
          body: JSON.stringify({ last4: wrong }),
        }),
        order.token,
        { db, env, redis, keyPrefix: prefix, appBaseUrl: APP },
      );
      expect([422, 429]).toContain(res.status);
    }
    const blocked = await act(order.token, { action: 'refuse', last4: order.last4 });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await orderRow(order.id)).status).toBe('ordered_at_supplier');
  });

  it('503 when Redis is unavailable (fail closed)', async () => {
    const order = await seed({ status: 'ordered_at_supplier' });
    const broken = {
      ...deps(),
      redis: { zcount: () => Promise.reject(new Error('down')) } as unknown as Redis,
    };
    const response = await handleOrderAction(
      new Request(`${APP}/api/orders/${order.token}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: APP },
        body: JSON.stringify({ action: 'refuse', last4: order.last4 }),
      }),
      order.token,
      broken,
    );
    expect(response.status).toBe(503);
    expect((await orderRow(order.id)).status).toBe('ordered_at_supplier');
  });
});
