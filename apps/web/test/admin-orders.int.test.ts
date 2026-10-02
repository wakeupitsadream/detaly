// The mini admin against local PG (docs/phase-1b-implementation.md section 15): the list with
// its filters and search, the card (the only place with the full phone), the QR block and the
// action handler (form -> performStaffAction as the owner -> 303 / 409). Orders are inserted
// directly with unique phones; list rows are created "in the future" so they top page 1 even
// when other test files add orders to the shared web database at the same time.
import { randomBytes, randomInt } from 'node:crypto';
import {
  and,
  asc,
  createDb,
  eq,
  orderEvents,
  orderItems,
  orders,
  payments,
  receipts,
  refunds,
  stockItems,
  supplierReturns,
  users,
  type Db,
} from '@detaly/db';
import type {
  Offer,
  OrderItemState,
  OrderStatus,
  PaymentScheme,
  ReceiptKind,
  ReceiptStatus,
} from '@detaly/domain';
import { loadStaffActions, type EngineDeps } from '@detaly/orders';
import type * as Navigation from 'next/navigation';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AdminOrderCard } from '@/components/admin/AdminOrderCard';
import { AdminOrderList } from '@/components/admin/AdminOrderList';
import { OrderDetails } from '@/components/order/OrderDetails';
import {
  handleAdminAction,
  parseRubToKop,
  splitIds,
  type AdminActionDeps,
} from '@/server/admin/actions-handler';
import { handoverQr } from '@/server/admin/handover-qr';
import {
  ADMIN_PAGE_SIZE,
  listAdminOrders,
  loadAdminOrder,
  parseAdminListQuery,
  parseAdminSearch,
} from '@/server/admin/queries';
import { loadOrderView } from '@/server/orders/order-view';
import { intEnv, webDatabaseUrl } from './helpers';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const APP = 'http://127.0.0.1:3100';
const ADMIN = 'admin:admin-test-password';
const AUTH = `Basic ${Buffer.from(ADMIN, 'utf8').toString('base64')}`;
const CLIENT_NAME = 'Админтест Клиентович';

let db: Db;
let engine: EngineDeps;
const logged: unknown[][] = [];

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 4 });
  engine = { db, env: intEnv({ ADMIN_BASIC_AUTH: ADMIN, APP_BASE_URL: APP }) };
});

afterAll(async () => {
  await db.close();
});

function deps(overrides: Partial<EngineDeps> = {}): AdminActionDeps {
  const log =
    (level: string) =>
    (...args: unknown[]) => {
      logged.push([level, ...args]);
    };
  return {
    engine: { ...engine, ...overrides },
    logger: { info: log('info'), warn: log('warn'), error: log('error') },
  };
}

function offer(brand: string, article: string): Offer {
  return {
    source: 'rossko',
    brand,
    article,
    articleNorm: article.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
    name: 'Фильтр масляный',
    group: null,
    isCross: false,
    priceSupplierKop: 40_000,
    stock: {
      stockId: 'MSK7',
      isLocal: false,
      count: 10,
      multiplicity: 1,
      type: null,
      deliveryDays: 3,
      deliveryStart: null,
      deliveryEnd: null,
      extra: null,
      description: null,
    },
  };
}

function randomPhone(): string {
  return `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

interface Seeded {
  id: string;
  number: string;
  token: string;
  phone: string;
  itemIds: string[];
  paymentId: string | null;
}

const ITEM_PRICE = 52_000;

/** In the future: these orders sort first in the admin list (created_at desc). */
let futureOffsetMs = 0;
function futureCreatedAt(): Date {
  futureOffsetMs += 1_000;
  return new Date(Date.now() + 24 * 3600_000 + futureOffsetMs);
}

async function seed({
  status,
  scheme = 'prepay',
  itemState = 'pending',
  paid = scheme === 'prepay' && status !== 'awaiting_payment',
  clientArrived = false,
  receipts: receiptRows = [],
  attentionReason = null,
  createdAt = new Date(),
}: {
  status: OrderStatus;
  scheme?: PaymentScheme;
  itemState?: OrderItemState;
  paid?: boolean;
  clientArrived?: boolean;
  receipts?: { kind: ReceiptKind; status: ReceiptStatus; alerted?: boolean; error?: string }[];
  attentionReason?: string | null;
  createdAt?: Date;
}): Promise<Seeded> {
  const phone = randomPhone();
  const [user] = await db.insert(users).values({ phone, name: CLIENT_NAME }).returning();
  if (!user) throw new Error('user not inserted');
  const token = randomBytes(32).toString('base64url');
  const total = 2 * ITEM_PRICE;
  const [order] = await db
    .insert(orders)
    .values({
      userId: user.id,
      accessToken: token,
      status,
      paymentScheme: scheme,
      subtotalKop: total,
      totalKop: total,
      itemsHash: 'admin-test',
      promisedDate: '2026-10-09',
      pickupCode: '482913',
      attentionReason,
      clientArrivedAt: clientArrived ? new Date() : null,
      createdAt,
    })
    .returning();
  if (!order) throw new Error('order not inserted');
  const items = await db
    .insert(orderItems)
    .values(
      [
        ['MANN', 'W 914/2'],
        ['BOSCH', 'F 026 407 006'],
      ].map(([brand = '', article = ''], index) => ({
        orderId: order.id,
        offerKey: `${article.replace(/\W/g, '')}:${brand}:MSK7`,
        searchArticleNorm: article.replace(/\W/g, '').toUpperCase(),
        brand,
        article,
        name: 'Фильтр масляный',
        qty: 1,
        stockId: 'MSK7',
        isLocal: false,
        priceSupplierAtOrderKop: 40_000,
        priceClientKop: ITEM_PRICE,
        markupBp: 3000,
        etaDate: '2026-10-08',
        offerSnapshot: offer(brand, article),
        state: itemState,
        createdAt: new Date(createdAt.getTime() + index),
      })),
    )
    .returning({ id: orderItems.id });
  let paymentId: string | null = null;
  if (paid) {
    const [payment] = await db
      .insert(payments)
      .values({
        orderId: order.id,
        providerPaymentId: `pay-${randomBytes(8).toString('hex')}`,
        kind: 'prepayment',
        status: 'succeeded',
        amountKop: total,
        idempotenceKey: randomBytes(16).toString('hex'),
        paidAt: new Date(),
      })
      .returning({ id: payments.id });
    paymentId = payment?.id ?? null;
    await db.insert(receipts).values({
      orderId: order.id,
      paymentId,
      kind: 'prepayment',
      status: 'succeeded',
      idempotenceKey: randomBytes(16).toString('hex'),
    });
  }
  for (const receipt of receiptRows) {
    await db.insert(receipts).values({
      orderId: order.id,
      paymentId,
      kind: receipt.kind,
      status: receipt.status,
      idempotenceKey: randomBytes(16).toString('hex'),
      alertedAt: receipt.alerted ? new Date() : null,
      error: receipt.error ?? null,
    });
  }
  await db.insert(orderEvents).values({
    orderId: order.id,
    type: 'checkout',
    fromStatus: 'draft',
    toStatus: scheme === 'prepay' ? 'awaiting_payment' : 'awaiting_confirmation',
    actorType: 'client',
    actorId: user.id,
    payload: { scheme, rule: 'Оформление: предоплата' },
    createdAt,
  });
  return {
    id: order.id,
    number: order.number,
    token,
    phone,
    itemIds: items.map((item) => item.id),
    paymentId,
  };
}

function form(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(`${APP}/api/admin/orders/x/actions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: APP,
      Authorization: AUTH,
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function orderRow(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  if (!row) throw new Error('order missing');
  return row;
}

async function itemStates(id: string): Promise<OrderItemState[]> {
  const rows = await db
    .select({ state: orderItems.state })
    .from(orderItems)
    .where(eq(orderItems.orderId, id))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  return rows.map((row) => row.state);
}

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function renderCard(id: string, done: string | null = null): Promise<string> {
  const card = await loadAdminOrder(db, id);
  const actions = await loadStaffActions(engine, id, 'owner');
  if (!card || !actions) throw new Error('card missing');
  return renderToStaticMarkup(
    createElement(AdminOrderCard, {
      card,
      actions,
      done,
      qr: await handoverQr(card),
      today: '2026-10-05',
    }),
  );
}

describe('admin list', () => {
  it('parses filters and the search text defensively', () => {
    expect(parseAdminListQuery({ status: 'needs_attention', q: ' DT-12 ', page: '3' })).toEqual({
      status: 'needs_attention',
      q: 'DT-12',
      page: 3,
    });
    expect(parseAdminListQuery({ status: 'nope', page: '-1' })).toEqual({
      status: null,
      q: '',
      page: 1,
    });
    expect(parseAdminListQuery({ status: ['attention', 'ready'] }).status).toBe('attention');
    expect(parseAdminSearch('DT-000123')).toEqual({ kind: 'number', number: 'DT-000123' });
    expect(parseAdminSearch('dt123')).toEqual({ kind: 'number', number: 'DT-000123' });
    expect(parseAdminSearch('12')).toEqual({ kind: 'number', number: 'DT-000012' });
    expect(parseAdminSearch('4567')).toEqual({
      kind: 'last4',
      last4: '4567',
      number: 'DT-004567',
    });
    expect(parseAdminSearch('Иванов')).toEqual({ kind: 'invalid' });
    expect(parseAdminSearch("1' or 1=1")).toEqual({ kind: 'invalid' });
  });

  it('filters by status and by «требуют внимания»', async () => {
    const attention = await seed({
      status: 'needs_attention',
      attentionReason: 'price_drift',
      createdAt: futureCreatedAt(),
    });
    const normal = await seed({ status: 'confirmed', createdAt: futureCreatedAt() });
    const receiptStuck = await seed({
      status: 'ready',
      itemState: 'arrived',
      clientArrived: true,
      receipts: [{ kind: 'offset', status: 'pending', alerted: true }],
      createdAt: futureCreatedAt(),
    });
    const receiptOk = await seed({
      status: 'ready',
      itemState: 'arrived',
      clientArrived: true,
      receipts: [
        { kind: 'offset', status: 'canceled', error: 'invalid_request: tax_system_code' },
        { kind: 'offset', status: 'succeeded' },
      ],
      createdAt: futureCreatedAt(),
    });
    const refundFailed = await seed({ status: 'refund_pending', createdAt: futureCreatedAt() });
    await db.insert(refunds).values({
      orderId: refundFailed.id,
      paymentId: refundFailed.paymentId as string,
      amountKop: 2 * ITEM_PRICE,
      reason: 'refusal',
      status: 'failed',
      idempotenceKey: randomBytes(16).toString('hex'),
      requestedAt: new Date(),
      deadlineAt: new Date(Date.now() + 10 * 86_400_000),
    });

    const confirmed = await listAdminOrders(db, { status: 'confirmed', q: '', page: 1 });
    expect(confirmed.rows.every((row) => row.status === 'confirmed')).toBe(true);
    expect(confirmed.rows.map((row) => row.id)).toContain(normal.id);
    expect(confirmed.rows.map((row) => row.id)).not.toContain(attention.id);

    const flagged = await listAdminOrders(db, { status: 'attention', q: '', page: 1 });
    const ids = flagged.rows.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([attention.id, receiptStuck.id, refundFailed.id]));
    expect(ids).not.toContain(normal.id);
    expect(ids).not.toContain(receiptOk.id);

    const all = await listAdminOrders(db, { status: null, q: '', page: 1 });
    expect(all.rows.length).toBeLessThanOrEqual(ADMIN_PAGE_SIZE);
    // Newest first.
    const times = all.rows.map((row) => row.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const html = renderToStaticMarkup(
      createElement(AdminOrderList, {
        query: { status: 'attention', q: '', page: 1 },
        list: flagged,
      }),
    );
    expect(html).toContain(attention.number);
    expect(html).toContain('href="/admin/orders/');
    expect(plain(html)).toContain('Цена выросла выше допуска');
    // The list never shows phones.
    expect(html).not.toContain(attention.phone);
  });

  it('finds an order by its number and by the last 4 phone digits', async () => {
    const order = await seed({ status: 'confirmed', createdAt: futureCreatedAt() });
    const byNumber = await listAdminOrders(db, { status: null, q: order.number, page: 1 });
    expect(byNumber.rows.map((row) => row.id)).toEqual([order.id]);
    const digits = order.number.replace('DT-', '').replace(/^0+/, '');
    const byShort = await listAdminOrders(db, { status: null, q: digits, page: 1 });
    expect(byShort.rows.map((row) => row.id)).toContain(order.id);

    const last4 = order.phone.slice(-4);
    const byPhone = await listAdminOrders(db, { status: null, q: last4, page: 1 });
    expect(byPhone.rows.map((row) => row.id)).toContain(order.id);
    const wrongStatus = await listAdminOrders(db, { status: 'ready', q: last4, page: 1 });
    expect(wrongStatus.rows.map((row) => row.id)).not.toContain(order.id);

    const invalid = await listAdminOrders(db, { status: null, q: 'Иванов', page: 1 });
    expect(invalid).toEqual({ rows: [], hasNext: false, invalidSearch: true });
  });
});

describe('admin card', () => {
  it('shows the full phone and name, which /o/<token> never shows', async () => {
    const order = await seed({ status: 'ordered_at_supplier', itemState: 'ordered' });
    const html = await renderCard(order.id, 'Отмечено: приехало');
    expect(html).toContain(order.phone);
    expect(html).toContain(`href="tel:${order.phone}"`);
    expect(html).toContain(CLIENT_NAME);
    expect(plain(html)).toContain('Отмечено: приехало');
    // Items, payments, receipts and the journal with its rule label and payload.
    expect(plain(html)).toContain('MANN W 914/2');
    expect(html).toContain('data-receipt="prepayment"');
    expect(plain(html)).toContain('Оформление: предоплата');
    expect(html).toContain('&quot;scheme&quot;: &quot;prepay&quot;');
    // The owner's buttons from availableStaffActions: «Приехало» per ordered item.
    expect(html).toContain(`data-action="iarr" data-item="${order.itemIds[0]}"`);
    expect(html).toContain('action="/api/admin/orders/');
    expect(html).toContain('data-action="refund_payment"');

    const view = await loadOrderView(db, order.token);
    if (!view) throw new Error('order view missing');
    expect(JSON.stringify(view)).not.toContain(order.phone);
    const page = renderToStaticMarkup(
      createElement(OrderDetails, {
        view,
        pickup: { name: null, address: null, hours: null, phone: null },
        contactPhone: null,
        cartReminder: null,
      }),
    );
    expect(page).not.toContain(order.phone);
    expect(page).not.toContain(order.phone.slice(1));
    expect(page).not.toContain(CLIENT_NAME);
  });

  it('shows «Выдал» disabled with the reason until the offset receipt succeeds', async () => {
    const order = await seed({
      status: 'ready',
      itemState: 'arrived',
      clientArrived: true,
      receipts: [{ kind: 'offset', status: 'pending' }],
    });
    const html = await renderCard(order.id);
    const handed = /<form[^>]*data-action="handed"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
    expect(handed).toContain('disabled');
    expect(plain(handed)).toContain('Ждём чек');
  });

  it('draws the QR of a pending handover payment as an SVG image', async () => {
    const order = await seed({
      status: 'awaiting_handover_payment',
      scheme: 'pay_on_handover',
      itemState: 'arrived',
      paid: false,
      clientArrived: true,
    });
    await db.insert(payments).values({
      orderId: order.id,
      providerPaymentId: `qr-${randomBytes(8).toString('hex')}`,
      kind: 'full',
      status: 'pending',
      amountKop: 2 * ITEM_PRICE,
      idempotenceKey: randomBytes(16).toString('hex'),
      confirmationType: 'qr',
      confirmationData: 'https://qr.nspk.ru/AD10006M8KH3LRS39ST9EV8SL0SBH2KR',
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const html = await renderCard(order.id);
    expect(html).toContain('data-testid="admin-qr"');
    expect(html).toContain('src="data:image/svg+xml;base64,');
    // The payload is drawn, not printed.
    expect(html).not.toContain('qr.nspk.ru');
  });
});

describe('POST /api/admin/orders/<id>/actions', () => {
  it('«Приехало» by form: 303 back to the card, the item arrives, the owner acts as admin', async () => {
    const order = await seed({ status: 'ordered_at_supplier', itemState: 'ordered' });
    const [first, second] = order.itemIds as [string, string];
    const response = await handleAdminAction(
      form({ action: 'iarr', itemId: first }),
      order.id,
      deps(),
    );
    expect(response.status).toBe(303);
    const location = response.headers.get('location') ?? '';
    expect(location.startsWith(`/admin/orders/${order.id}?done=`)).toBe(true);
    expect(decodeURIComponent(location.split('done=')[1] ?? '')).toBe('Отмечено: приехало');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await itemStates(order.id)).toEqual(['arrived', 'ordered']);
    expect((await orderRow(order.id)).status).toBe('ordered_at_supplier');

    const [event] = await db
      .select()
      .from(orderEvents)
      .where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.type, 'item_arrived')));
    expect(event).toMatchObject({ actorType: 'staff', actorId: 'admin' });
    expect(event?.payload).toMatchObject({ via: 'admin', itemId: first });

    // The second one makes the order ready.
    const again = await handleAdminAction(
      form({ action: 'iarr', itemId: second }),
      order.id,
      deps(),
    );
    expect(again.status).toBe(303);
    expect((await orderRow(order.id)).status).toBe('ready');
    // Logs: number, action and outcome; no phone.
    expect(JSON.stringify(logged)).toContain(order.number);
    expect(JSON.stringify(logged)).not.toContain(order.phone);
  });

  it('accepts the browser form of the no-referrer card (Origin: null, Sec-Fetch-Site)', async () => {
    // Referrer-Policy: no-referrer on /admin makes Chromium post `Origin: null`.
    const order = await seed({ status: 'ordered_at_supplier', itemState: 'ordered' });
    const [first] = order.itemIds as [string, string];
    const crossSite = await handleAdminAction(
      form({ action: 'iarr', itemId: first }, { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }),
      order.id,
      deps(),
    );
    expect(crossSite.status).toBe(403);
    expect(await itemStates(order.id)).toEqual(['ordered', 'ordered']);
    const browser = await handleAdminAction(
      form({ action: 'iarr', itemId: first }, { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }),
      order.id,
      deps(),
    );
    expect(browser.status).toBe(303);
    expect(await itemStates(order.id)).toEqual(['arrived', 'ordered']);
  });

  it('refuses an irreversible action without the «подтверждаю» tick', async () => {
    const order = await seed({ status: 'ordered_at_supplier', itemState: 'ordered' });
    const [first] = order.itemIds as [string, string];
    const unconfirmed: Record<string, string>[] = [
      { action: 'refused' },
      { action: 'icancel', itemId: first },
      { action: 'refund_payment', paymentId: order.paymentId as string, reason: 'дубль' },
      { action: 'refused', confirm: 'yes' },
    ];
    for (const fields of unconfirmed) {
      const response = await handleAdminAction(form(fields), order.id, deps());
      expect(response.status, fields.action).toBe(400);
      expect(plain(await response.text())).toContain('подтверждаю');
    }
    expect((await orderRow(order.id)).status).toBe('ordered_at_supplier');
    expect(await itemStates(order.id)).toEqual(['ordered', 'ordered']);
    const refundRows = await db.select().from(refunds).where(eq(refunds.orderId, order.id));
    expect(refundRows).toEqual([]);
    // With the tick the engine decides (here: refused goes to its own rules, not to the form check).
    const confirmed = await handleAdminAction(
      form({ action: 'refused', confirm: 'on' }),
      order.id,
      deps(),
    );
    expect(confirmed.status).not.toBe(400);
  });

  it('«Rossko не принял возврат»: the return is rejected and the part goes to stock', async () => {
    const order = await seed({ status: 'handed', itemState: 'handed' });
    const [first] = order.itemIds as [string, string];
    const [ret] = await db
      .insert(supplierReturns)
      .values({
        orderItemId: first,
        kind: 'return',
        status: 'requested',
        amountExpectedKop: 40_000,
      })
      .returning();
    const response = await handleAdminAction(
      form({ action: 'supplier_return_reject', supplierReturnId: ret?.id as string, note: 'брак' }),
      order.id,
      deps(),
    );
    expect(response.status).toBe(303);
    const [updated] = await db
      .select()
      .from(supplierReturns)
      .where(eq(supplierReturns.id, ret?.id as string));
    expect(updated?.status).toBe('rejected');
    const stock = await db.select().from(stockItems).where(eq(stockItems.orderItemId, first));
    expect(stock).toHaveLength(1);
    expect(stock[0]?.costKop).toBe(40_000);
    // A second decision on the same return is refused by the engine.
    const again = await handleAdminAction(
      form({ action: 'supplier_return_accept', supplierReturnId: ret?.id as string }),
      order.id,
      deps(),
    );
    expect(again.status).toBe(409);
  });

  it('«Выдал» without a succeeded receipt: 409 with the reason, nothing changes', async () => {
    const order = await seed({
      status: 'ready',
      itemState: 'arrived',
      clientArrived: true,
      receipts: [{ kind: 'offset', status: 'pending' }],
    });
    const response = await handleAdminAction(form({ action: 'handed' }), order.id, deps());
    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('text/html');
    const text = plain(await response.text());
    expect(text).toContain('Ждём чек');
    expect(text).toContain('Вернуться к заказу');
    expect((await orderRow(order.id)).status).toBe('ready');
    expect(await itemStates(order.id)).toEqual(['arrived', 'arrived']);
  });

  it('checks Basic auth again, then Origin, the order and the form', async () => {
    const order = await seed({ status: 'ordered_at_supplier', itemState: 'ordered' });
    const item = order.itemIds[0] as string;

    const noAuth = await handleAdminAction(
      form({ action: 'iarr', itemId: item }, { Authorization: '' }),
      order.id,
      deps(),
    );
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toBe('Basic realm="admin", charset="UTF-8"');
    const wrong = await handleAdminAction(
      form(
        { action: 'iarr', itemId: item },
        { Authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` },
      ),
      order.id,
      deps(),
    );
    expect(wrong.status).toBe(401);
    const disabled = await handleAdminAction(
      form({ action: 'iarr', itemId: item }),
      order.id,
      deps({ env: intEnv({ APP_BASE_URL: APP }) }),
    );
    expect(disabled.status).toBe(404);
    const foreign = await handleAdminAction(
      form({ action: 'iarr', itemId: item }, { Origin: 'https://evil.example' }),
      order.id,
      deps(),
    );
    expect(foreign.status).toBe(403);
    const missing = await handleAdminAction(
      form({ action: 'iarr', itemId: item }),
      '0192d8a4-0000-7000-8000-000000000001',
      deps(),
    );
    expect(missing.status).toBe(404);
    expect((await handleAdminAction(form({ action: 'iarr' }), 'not-a-uuid', deps())).status).toBe(
      404,
    );
    const unknown = await handleAdminAction(form({ action: 'drop_table' }), order.id, deps());
    expect(unknown.status).toBe(400);
    const json = await handleAdminAction(
      new Request(`${APP}/x`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: APP, Authorization: AUTH },
        body: JSON.stringify({ action: 'iarr', itemId: item }),
      }),
      order.id,
      deps(),
    );
    expect(json.status).toBe(400);

    // An item of another order is refused before the engine runs.
    const other = await seed({ status: 'ordered_at_supplier', itemState: 'ordered' });
    const foreignItem = await handleAdminAction(
      form({ action: 'iarr', itemId: other.itemIds[0] as string }),
      order.id,
      deps(),
    );
    expect(foreignItem.status).toBe(400);
    expect(plain(await foreignItem.text())).toContain('Позиция не найдена в этом заказе');

    const noReason = await handleAdminAction(
      form({ action: 'refund_payment', paymentId: order.paymentId as string }),
      order.id,
      deps(),
    );
    expect(noReason.status).toBe(400);
    const noPp = await handleAdminAction(
      form({ action: 'invpaid', ppNumber: '123' }),
      order.id,
      deps(),
    );
    expect(noPp.status).toBe(400);

    expect(await itemStates(order.id)).toEqual(['ordered', 'ordered']);
    expect(await itemStates(other.id)).toEqual(['ordered', 'ordered']);
  });

  it('records «Заказано вручную в ЛК Rossko» from needs_attention', async () => {
    const order = await seed({
      status: 'needs_attention',
      attentionReason: 'unknown_after_timeout',
    });
    const response = await handleAdminAction(
      form({ action: 'manual_supplier_order', rosskoOrderIds: '1234567, 7654321' }),
      order.id,
      deps(),
    );
    expect(response.status).toBe(303);
    expect(await itemStates(order.id)).toEqual(['ordered', 'ordered']);
    const card = await loadAdminOrder(db, order.id);
    expect(card?.supplierOrders.map((so) => so.rosskoOrderIds)).toEqual([['1234567', '7654321']]);
    expect(card?.events.map((event) => event.type)).toContain('supplier_order_manual');
  });
});

describe('form helpers', () => {
  it('parses rubles to kopecks and splits Rossko numbers', () => {
    expect(parseRubToKop('1 234,50')).toBe(123_450);
    expect(parseRubToKop('1234.5')).toBe(123_450);
    expect(parseRubToKop('99')).toBe(9_900);
    expect(parseRubToKop('-5')).toBeNull();
    expect(parseRubToKop('1,234')).toBeNull();
    expect(parseRubToKop('abc')).toBeNull();
    expect(splitIds(' 12345, 67890 / 555;7 ')).toEqual(['12345', '67890', '555', '7']);
  });
});
