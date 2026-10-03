// Phase 1C forms of /o/<token> (docs/phase-1c-implementation.md section 10, item 8) against
// local PG and Redis: «Статусы в Telegram» (link token, 303 to t.me), the installation booking
// (slot, the same requestKey, a taken slot, the race for the last lift, cancel), the claim form
// (digits, photos, kinds, repeats), the packaging photo route and the page HTML. Orders are
// inserted directly; every test uses its own phone and token, Redis keys live under
// test:<uuid>:, photos go to a memory FileStore.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import {
  claims,
  createDb,
  eq,
  installBookings,
  linkTokens,
  orderEvents,
  orderItems,
  orderPhotos,
  orders,
  payments,
  users,
  type Db,
} from '@detaly/db';
import type { Offer, OrderItemState, OrderStatus } from '@detaly/domain';
import { INSTALL_LIFTS } from '@detaly/domain/install-params';
import { createMemoryFileStore, newFileKey, type MemoryFileStore } from '@detaly/files';
import { installSlotsForOrder, type EngineDeps } from '@detaly/orders';
import type * as Navigation from 'next/navigation';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderDetails } from '@/components/order/OrderDetails';
import { handleClaimRequest } from '@/server/orders/claim-handler';
import { parseOrderFlash } from '@/server/orders/flash';
import { handleInstallCancel, handleInstallRequest } from '@/server/orders/install-handler';
import { handleLinkRequest } from '@/server/orders/link-handler';
import { loadOrderServices } from '@/server/orders/order-services';
import { loadOrderView } from '@/server/orders/order-view';
import { handleOrderPhoto } from '@/server/orders/photo-handler';
import { intEnv, webDatabaseUrl } from './helpers';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const APP = 'http://127.0.0.1:3100';
const BOT = 'detaly_test_bot';
const PARTNER = 'Тестовый сервис';
const REQUISITES = 'ИП Тестов Т. Т., ИНН 561234567890';
const prefix = testKeyPrefix();
let db: Db;
let redis: Redis;
let files: MemoryFileStore;

const ENV = intEnv({
  APP_BASE_URL: APP,
  TG_CLIENT_BOT_USERNAME: BOT,
  INSTALL_PARTNER_NAME: PARTNER,
  INSTALL_PARTNER_REQUISITES: REQUISITES,
});
const ENV_BARE = intEnv({ APP_BASE_URL: APP });

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 6 });
  redis = createRedis(testRedisUrl());
  files = createMemoryFileStore();
});

afterAll(async () => {
  await deleteKeysByPrefix(redis, prefix);
  await redis.quit();
  await db.close();
});

function engine(env = ENV): EngineDeps {
  return { db, env };
}

interface Inserted {
  id: string;
  token: string;
  number: string;
  userId: string;
  phone: string;
  last4: string;
  itemIds: string[];
}

const DAY_MS = 86_400_000;

function offer(brand: string, article: string, name: string): Offer {
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

async function insertOrder({
  status = 'handed',
  scheme = 'pay_on_handover',
  itemState = status === 'handed' ? 'handed' : 'arrived',
  handedAt = status === 'handed' ? new Date(Date.now() - DAY_MS) : null,
  promisedDate = '2026-10-08',
}: {
  status?: OrderStatus;
  scheme?: 'prepay' | 'pay_on_handover';
  itemState?: OrderItemState;
  handedAt?: Date | null;
  promisedDate?: string | null;
} = {}): Promise<Inserted> {
  const phone = `+79${randomInt(100_000_000, 1_000_000_000)}`;
  const [user] = await db.insert(users).values({ phone, name: 'Клиент Претензиев' }).returning();
  if (!user) throw new Error('user not inserted');
  const token = randomBytes(32).toString('base64url');
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
      promisedDate,
      pickupCode: '482913',
      preferredChannel: 'telegram',
      handedAt,
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
        offerSnapshot: offer('Knecht', 'OC 90', 'Фильтр масляный'),
        state: itemState,
      },
      {
        orderId: order.id,
        offerKey: 'GDB1330:TRW:ORB1',
        searchArticleNorm: 'GDB1330',
        brand: 'TRW',
        article: 'GDB1330',
        name: 'Колодки тормозные',
        qty: 1,
        stockId: 'ORB1',
        isLocal: true,
        priceSupplierAtOrderKop: 90_000,
        priceClientKop: 117_000,
        markupBp: 3000,
        etaDate: '2026-10-03',
        offerSnapshot: offer('TRW', 'GDB1330', 'Колодки тормозные'),
        state: itemState,
      },
    ])
    .returning({ id: orderItems.id });
  await db.insert(orderEvents).values({
    orderId: order.id,
    type: 'checkout',
    fromStatus: 'draft',
    toStatus: 'awaiting_confirmation',
    actorType: 'client',
    actorId: user.id,
    payload: { scheme },
  });
  return {
    id: order.id,
    token,
    number: order.number,
    userId: user.id,
    phone,
    last4: phone.slice(-4),
    itemIds: items.map((i) => i.id),
  };
}

function form(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

function post(
  path: string,
  body: BodyInit | null,
  { json = true, origin = APP }: { json?: boolean; origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.Origin = origin;
  if (json) headers.Accept = 'application/json';
  return new Request(`${APP}${path}`, { method: 'POST', headers, body });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------

describe('POST /api/orders/<token>/link', () => {
  it('creates a one-time link token and answers 303 to the bot without the order token', async () => {
    const order = await insertOrder({ status: 'ready' });
    const response = await handleLinkRequest(
      post(`/api/orders/${order.token}/link`, form({ channel: 'telegram' }), { json: false }),
      order.token,
      { engine: engine(), appBaseUrl: APP },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const location = response.headers.get('location') ?? '';
    const match = /^https:\/\/t\.me\/detaly_test_bot\?start=([A-Za-z0-9_-]{32})$/.exec(location);
    expect(match, location).not.toBeNull();
    expect(location).not.toContain(order.token);
    const [row] = await db
      .select()
      .from(linkTokens)
      .where(eq(linkTokens.token, match?.[1] ?? ''));
    expect(row).toMatchObject({ userId: order.userId, orderId: order.id, usedAt: null });
    expect(row!.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
  });

  it('every press is a new token (one-time links)', async () => {
    const order = await insertOrder({ status: 'ready' });
    const press = () =>
      handleLinkRequest(
        post(`/api/orders/${order.token}/link`, null, { json: true }),
        order.token,
        { engine: engine(), appBaseUrl: APP },
      ).then(jsonOf);
    const [a, b] = [await press(), await press()];
    expect(a.redirectUrl).not.toBe(b.redirectUrl);
    const rows = await db.select().from(linkTokens).where(eq(linkTokens.orderId, order.id));
    expect(rows).toHaveLength(2);
  });

  it('without TG_CLIENT_BOT_USERNAME: 409 for scripts, 303 back with a flash for forms', async () => {
    const order = await insertOrder({ status: 'ready' });
    const deps = { engine: engine(ENV_BARE), appBaseUrl: APP };
    const json = await handleLinkRequest(
      post(`/api/orders/${order.token}/link`, null),
      order.token,
      deps,
    );
    expect(json.status).toBe(409);
    const html = await handleLinkRequest(
      post(`/api/orders/${order.token}/link`, form({ channel: 'telegram' }), { json: false }),
      order.token,
      deps,
    );
    expect(html.status).toBe(303);
    expect(html.headers.get('location')).toBe(
      `${APP}/o/${order.token}?flash=link_unavailable#notify`,
    );
    expect(await db.select().from(linkTokens).where(eq(linkTokens.orderId, order.id))).toEqual([]);
  });

  it('MAX is not available yet; foreign Origin 403; unknown token 404', async () => {
    const order = await insertOrder({ status: 'ready' });
    const deps = { engine: engine(), appBaseUrl: APP };
    const max = await handleLinkRequest(
      post(`/api/orders/${order.token}/link`, form({ channel: 'max' }), { json: false }),
      order.token,
      deps,
    );
    expect(max.headers.get('location')).toContain('flash=link_unavailable');
    const foreign = await handleLinkRequest(
      post(`/api/orders/${order.token}/link`, null, { origin: 'https://evil.example' }),
      order.token,
      deps,
    );
    expect(foreign.status).toBe(403);
    const unknown = randomBytes(32).toString('base64url');
    expect(
      (await handleLinkRequest(post(`/api/orders/${unknown}/link`, null), unknown, deps)).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------

async function freeSlots(orderId: string): Promise<string[]> {
  const { slots } = await installSlotsForOrder(db, {
    orderId,
    now: new Date(),
    schedule: (await import('@detaly/domain')).parseWorkHours(ENV.PICKUP_HOURS ?? null),
    limit: 10,
  });
  return slots.map((slot) => slot.startAt);
}

/** `count` confirmed bookings of other orders at `slotAt` (they hold the lifts). */
async function occupy(slotAt: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const other = await insertOrder({ status: 'ready' });
    await db.insert(installBookings).values({
      orderId: other.id,
      userId: other.userId,
      slotAt: new Date(slotAt),
      status: 'confirmed',
      requestKey: randomUUID(),
      createdVia: 'admin',
    });
  }
}

function book(order: Inserted, fields: Record<string, string>, env = ENV, json = true) {
  return handleInstallRequest(
    post(`/api/orders/${order.token}/install`, form(fields), { json }),
    order.token,
    { engine: engine(env), appBaseUrl: APP },
  );
}

describe('POST /api/orders/<token>/install', () => {
  it('books a slot; the same requestKey returns the same booking; a second booking is 409', async () => {
    const order = await insertOrder({ status: 'ready' });
    const [slotAt] = await freeSlots(order.id);
    expect(slotAt).toBeDefined();
    const requestKey = randomUUID();
    const first = await book(order, { slotAt: slotAt!, requestKey });
    expect(first.status).toBe(200);
    const body = await jsonOf(first);
    expect(body).toMatchObject({ status: 'booked', duplicate: false });
    const again = await jsonOf(await book(order, { slotAt: slotAt!, requestKey }));
    expect(again).toMatchObject({ bookingId: body.bookingId, duplicate: true });
    const rows = await db
      .select()
      .from(installBookings)
      .where(eq(installBookings.orderId, order.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'requested', createdVia: 'web' });
    expect(rows[0]!.slotAt.getTime()).toBe(Date.parse(slotAt!));
    // No price anywhere in the booking row (decision С6).
    expect(Object.keys(rows[0]!).some((key) => /kop|price/i.test(key))).toBe(false);

    const second = await book(order, { slotAt: slotAt!, requestKey: randomUUID() });
    expect(second.status).toBe(409);
    expect(await jsonOf(second)).toMatchObject({ error: 'already_booked' });
  });

  it('a form post answers 303 back to #install with a flash', async () => {
    const order = await insertOrder({ status: 'ready' });
    const [slotAt] = await freeSlots(order.id);
    const response = await book(order, { slotAt: slotAt!, requestKey: randomUUID() }, ENV, false);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${APP}/o/${order.token}?flash=install_booked#install`,
    );
  });

  it('a taken slot is 409 with a text; a slot outside the plan is 422', async () => {
    const order = await insertOrder({ status: 'ready' });
    const slots = await freeSlots(order.id);
    const taken = slots[2]!;
    await occupy(taken, INSTALL_LIFTS);
    const response = await book(order, { slotAt: taken, requestKey: randomUUID() });
    expect(response.status).toBe(409);
    expect(await jsonOf(response)).toMatchObject({
      error: 'slot_taken',
      message: 'Это время только что заняли — выберите другое',
    });
    const odd = new Date(Date.parse(slots[0]!) + 17 * 60_000).toISOString();
    const bad = await book(order, { slotAt: odd, requestKey: randomUUID() });
    expect(bad.status).toBe(422);
    const garbage = await book(order, { slotAt: 'tomorrow', requestKey: randomUUID() });
    expect(garbage.status).toBe(422);
    expect(
      await db.select().from(installBookings).where(eq(installBookings.orderId, order.id)),
    ).toEqual([]);
  });

  it('two clients race for the last lift of an hour: one booking, one 409', async () => {
    const a = await insertOrder({ status: 'ready' });
    const b = await insertOrder({ status: 'ready' });
    const slots = await freeSlots(a.id);
    const last = slots[4]!;
    await occupy(last, INSTALL_LIFTS - 1);
    const results = await Promise.all([
      book(a, { slotAt: last, requestKey: randomUUID() }),
      book(b, { slotAt: last, requestKey: randomUUID() }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const holding = await db
      .select()
      .from(installBookings)
      .where(eq(installBookings.slotAt, new Date(last)));
    expect(holding.filter((row) => row.status !== 'cancelled')).toHaveLength(INSTALL_LIFTS);
  });

  it('without INSTALL_PARTNER_NAME bookings are off (409); a closed order is 409', async () => {
    const order = await insertOrder({ status: 'ready' });
    const [slotAt] = await freeSlots(order.id);
    const off = await book(order, { slotAt: slotAt!, requestKey: randomUUID() }, ENV_BARE);
    expect(off.status).toBe(409);
    const cancelled = await insertOrder({ status: 'cancelled' });
    const closed = await book(cancelled, { slotAt: slotAt!, requestKey: randomUUID() });
    expect(closed.status).toBe(409);
  });

  it('the client cancels their own booking; another order’s booking is 404', async () => {
    const order = await insertOrder({ status: 'ready' });
    const other = await insertOrder({ status: 'ready' });
    const [slotAt] = await freeSlots(order.id);
    const booked = await jsonOf(await book(order, { slotAt: slotAt!, requestKey: randomUUID() }));
    const bookingId = String(booked.bookingId);
    const foreign = await handleInstallCancel(
      post(`/api/orders/${other.token}/install/cancel`, form({ bookingId })),
      other.token,
      { engine: engine(), appBaseUrl: APP },
    );
    expect(foreign.status).toBe(404);
    const response = await handleInstallCancel(
      post(`/api/orders/${order.token}/install/cancel`, form({ bookingId }), { json: false }),
      order.token,
      { engine: engine(), appBaseUrl: APP },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('flash=install_cancelled#install');
    const [row] = await db.select().from(installBookings).where(eq(installBookings.id, bookingId));
    expect(row?.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------------------------

let jpegBytes: Uint8Array<ArrayBuffer> | null = null;

async function jpeg(): Promise<Uint8Array<ArrayBuffer>> {
  if (jpegBytes === null) {
    const { default: sharp } = await import('sharp');
    jpegBytes = new Uint8Array(
      await sharp({
        create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 120, b: 40 } },
      })
        .jpeg()
        .toBuffer(),
    );
  }
  return jpegBytes;
}

async function claimForm(fields: Record<string, string>, photos = 0): Promise<FormData> {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  const bytes = await jpeg();
  for (let i = 0; i < photos; i += 1) {
    data.append('photos', new File([bytes], `photo-${i}.jpg`, { type: 'image/jpeg' }));
  }
  return data;
}

function claim(order: Inserted, body: FormData, json = true) {
  return handleClaimRequest(
    post(`/api/orders/${order.token}/claims`, body, { json }),
    order.token,
    {
      engine: engine(),
      redis,
      keyPrefix: prefix,
      files,
      maxFileBytes: 8 * 1024 * 1024,
      appBaseUrl: APP,
    },
  );
}

function claimsOf(orderId: string) {
  return db.select().from(claims).where(eq(claims.orderId, orderId));
}

describe('POST /api/orders/<token>/claims', () => {
  it('wrong digits: 422 with attempts left, nothing stored', async () => {
    const order = await insertOrder();
    const wrong = order.last4 === '0000' ? '1111' : '0000';
    const before = files.keys().length;
    const response = await claim(
      order,
      await claimForm({ kind: 'defect', last4: wrong, requestKey: randomUUID(), text: 'Течёт' }, 2),
    );
    expect(response.status).toBe(422);
    expect(await jsonOf(response)).toMatchObject({ error: 'wrong_digits', attemptsLeft: 4 });
    expect(await claimsOf(order.id)).toEqual([]);
    expect(files.keys().length).toBe(before);
  });

  it('without photos: a claims row with the deadline +10 days', async () => {
    const order = await insertOrder();
    const response = await claim(
      order,
      await claimForm({ kind: 'not_fit', last4: order.last4, requestKey: randomUUID() }),
    );
    expect(response.status).toBe(200);
    const [row] = await claimsOf(order.id);
    expect(row).toMatchObject({ kind: 'not_fit', orderItemId: null, openedVia: 'web' });
    expect(row!.deadlineAt.getTime() - row!.openedAt.getTime()).toBe(10 * DAY_MS);
    expect(row!.photos).toEqual([]);
  });

  it('with 2 photos on one item: the files are in the store under claim/<order id>/', async () => {
    const order = await insertOrder();
    const response = await claim(
      order,
      await claimForm(
        {
          kind: 'defect',
          itemId: order.itemIds[0]!,
          text: 'Не держит давление',
          last4: order.last4,
          requestKey: randomUUID(),
        },
        2,
      ),
    );
    expect(response.status).toBe(200);
    const [row] = await claimsOf(order.id);
    expect(row).toMatchObject({ orderItemId: order.itemIds[0], clientText: 'Не держит давление' });
    const keys = row!.photos as string[];
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key.startsWith(`claim/${order.id}/`)).toBe(true);
      expect(files.keys()).toContain(key);
    }
  });

  it('4 photos: 413, nothing stored', async () => {
    const order = await insertOrder();
    const before = files.keys().length;
    const response = await claim(
      order,
      await claimForm({ kind: 'defect', last4: order.last4, requestKey: randomUUID() }, 4),
    );
    expect(response.status).toBe(413);
    expect(await claimsOf(order.id)).toEqual([]);
    expect(files.keys().length).toBe(before);
  });

  it('a file that is not an image: 422', async () => {
    const order = await insertOrder();
    const data = await claimForm({ kind: 'defect', last4: order.last4, requestKey: randomUUID() });
    data.append('photos', new File(['not a photo'], 'x.jpg', { type: 'image/jpeg' }));
    expect((await claim(order, data)).status).toBe(422);
  });

  it('refusal 8 days after the handover: 409 and the uploaded photos are dropped', async () => {
    const order = await insertOrder({ handedAt: new Date(Date.now() - 9 * DAY_MS) });
    const before = files.keys().length;
    const response = await claim(
      order,
      await claimForm({ kind: 'refusal', last4: order.last4, requestKey: randomUUID() }, 1),
    );
    expect(response.status).toBe(409);
    expect(await jsonOf(response)).toMatchObject({ error: 'kind_unavailable' });
    expect(await claimsOf(order.id)).toEqual([]);
    expect(files.keys().length).toBe(before);
  });

  it('the same requestKey twice: one claim; a second whole-order claim: 409', async () => {
    const order = await insertOrder();
    const requestKey = randomUUID();
    const fields = { kind: 'refusal', last4: order.last4, requestKey };
    const first = await jsonOf(await claim(order, await claimForm(fields, 1)));
    const before = files.keys().length;
    const second = await jsonOf(await claim(order, await claimForm(fields, 1)));
    expect(second.claimId).toBe(first.claimId);
    expect(files.keys().length).toBe(before);
    expect(await claimsOf(order.id)).toHaveLength(1);
    const another = await claim(
      order,
      await claimForm({ kind: 'defect', last4: order.last4, requestKey: randomUUID() }),
    );
    expect(another.status).toBe(409);
  });

  it('a form post answers 303 to #claim; before the handover only a delay with money held', async () => {
    const order = await insertOrder();
    const response = await claim(
      order,
      await claimForm({ kind: 'defect', last4: order.last4, requestKey: randomUUID() }),
      false,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${APP}/o/${order.token}?flash=claim_opened#claim`,
    );
    const ready = await insertOrder({ status: 'ready' });
    const refused = await claim(
      ready,
      await claimForm({ kind: 'defect', last4: ready.last4, requestKey: randomUUID() }),
    );
    expect(refused.status).toBe(409);
  });

  it('a delay before the handover: the whole order only (the form has no items, an item post is 422)', async () => {
    const order = await insertOrder({
      status: 'ordered_at_supplier',
      scheme: 'prepay',
      itemState: 'ordered',
      promisedDate: '2026-01-05',
    });
    await db.insert(payments).values({
      orderId: order.id,
      kind: 'prepayment',
      status: 'succeeded',
      amountKop: 2 * 52_800 + 117_000,
      idempotenceKey: randomUUID(),
      providerPaymentId: `pay-${randomUUID()}`,
      confirmationType: 'redirect',
      paidAt: new Date(),
    });
    const html = await renderOrder(order);
    expect(html).toContain('data-testid="claim-kind-delay"');
    // One target only: the whole order goes as a hidden field, no item radios.
    expect(html).not.toContain('data-testid="claim-target"');
    const byItem = await claim(
      order,
      await claimForm({
        kind: 'delay',
        itemId: order.itemIds[0]!,
        last4: order.last4,
        requestKey: randomUUID(),
      }),
    );
    expect(byItem.status).toBe(422);
    expect(await claimsOf(order.id)).toEqual([]);
    const whole = await claim(
      order,
      await claimForm({ kind: 'delay', last4: order.last4, requestKey: randomUUID() }),
    );
    expect(whole.status).toBe(200);
  });

  it('missing digits or kind: 422; foreign Origin: 403', async () => {
    const order = await insertOrder();
    expect(
      (await claim(order, await claimForm({ kind: 'defect', requestKey: randomUUID() }))).status,
    ).toBe(422);
    expect(
      (await claim(order, await claimForm({ last4: order.last4, requestKey: randomUUID() })))
        .status,
    ).toBe(422);
    const foreign = await handleClaimRequest(
      post(`/api/orders/${order.token}/claims`, await claimForm({}), {
        origin: 'https://evil.example',
      }),
      order.token,
      {
        engine: engine(),
        redis,
        keyPrefix: prefix,
        files,
        maxFileBytes: 8 * 1024 * 1024,
        appBaseUrl: APP,
      },
    );
    expect(foreign.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------

async function addPhoto(order: Inserted, kind: 'packaging' | 'handover' | 'return') {
  const key = newFileKey(kind === 'return' ? 'claim' : 'order', order.id);
  await files.put(key, await jpeg());
  let claimId: string | null = null;
  if (kind === 'return') {
    const [row] = await db
      .insert(claims)
      .values({
        orderId: order.id,
        kind: 'defect',
        openedAt: new Date(),
        deadlineAt: new Date(Date.now() + 10 * DAY_MS),
        requestKey: randomUUID(),
      })
      .returning({ id: claims.id });
    claimId = row!.id;
  }
  const [photo] = await db
    .insert(orderPhotos)
    .values({ orderId: order.id, kind, s3Key: key, claimId })
    .returning({ id: orderPhotos.id });
  return photo!.id;
}

describe('GET /api/orders/<token>/photos/<id>', () => {
  it('serves a packaging photo of this order only, private and not stored', async () => {
    const order = await insertOrder({ status: 'ready' });
    const other = await insertOrder({ status: 'ready' });
    const photoId = await addPhoto(order, 'packaging');
    const ok = await handleOrderPhoto(order.token, photoId, { db, files });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(await jpeg());
    // Another order's token, a return photo, an unknown id, a malformed token: the same 404.
    expect((await handleOrderPhoto(other.token, photoId, { db, files })).status).toBe(404);
    const returnId = await addPhoto(order, 'return');
    expect((await handleOrderPhoto(order.token, returnId, { db, files })).status).toBe(404);
    expect((await handleOrderPhoto(order.token, randomUUID(), { db, files })).status).toBe(404);
    expect((await handleOrderPhoto('bad', photoId, { db, files })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------

const PICKUP = {
  name: 'Тестовый пункт',
  address: 'г. Оренбург, ул. Тестовая, 1',
  hours: 'Пн–Пт 10:00–19:00',
  phone: '+7 900 000-00-01',
};

async function renderOrder(order: Inserted, query: Record<string, string> = {}): Promise<string> {
  const view = await loadOrderView(db, order.token, { env: ENV });
  if (!view) throw new Error('view missing');
  const services = await loadOrderServices(db, view, {
    env: ENV,
    photosEnabled: true,
    maxFileMb: 8,
  });
  return renderToStaticMarkup(
    createElement(OrderDetails, {
      view,
      services,
      flash: parseOrderFlash(query),
      pickup: PICKUP,
      contactPhone: PICKUP.phone,
      cartReminder: null,
    }),
  );
}

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

describe('order page with the phase 1C blocks', () => {
  it('ready: the Telegram form, slots with the partner text and no price, the packaging photo', async () => {
    const order = await insertOrder({ status: 'ready' });
    const photoId = await addPhoto(order, 'packaging');
    const html = await renderOrder(order);
    const text = plain(html);
    expect(html).toContain(`action="/api/orders/${order.token}/link"`);
    expect(text).toContain('Статусы в Telegram');
    expect(text).toContain('не вход в аккаунт');
    expect(html).toContain('data-testid="messenger-max"');
    expect(html).toContain(`action="/api/orders/${order.token}/install"`);
    expect((html.match(/data-testid="install-slot"/g) ?? []).length).toBeGreaterThan(0);
    expect((html.match(/data-testid="install-slot"/g) ?? []).length).toBeLessThanOrEqual(6);
    expect(text).toContain(
      `Установка — услуга ${PARTNER} (${REQUISITES}), оплачивается в сервисе по его чеку.`,
    );
    expect(html).toContain(`/api/orders/${order.token}/photos/${photoId}`);
    // No claim before the handover (no delay: not paid), no memo.
    expect(html).not.toContain('data-testid="claim-form"');
    // No phone, no name of the client.
    expect(text).not.toContain(order.phone);
    expect(text).not.toContain(order.phone.slice(2));
    expect(text).not.toContain('Претензиев');
  });

  it('handed: the claim form with 3 kinds and the memo; an open claim shows the steps and the deadline', async () => {
    const order = await insertOrder();
    const other = await insertOrder();
    let html = await renderOrder(order);
    expect(html).toContain('data-testid="claim-form"');
    for (const kind of ['refusal', 'not_fit', 'defect']) {
      expect(html).toContain(`data-testid="claim-kind-${kind}"`);
    }
    expect(html).not.toContain('data-testid="claim-kind-delay"');
    expect(html).toContain('href="/print/pamyatka-vozvrat.pdf"');

    await claim(
      other,
      await claimForm({
        kind: 'defect',
        text: 'Секрет другого заказа',
        last4: other.last4,
        requestKey: randomUUID(),
      }),
    );
    await claim(
      order,
      await claimForm({
        kind: 'not_fit',
        text: 'Не подошла к машине',
        last4: order.last4,
        requestKey: randomUUID(),
      }),
    );
    html = await renderOrder(order, { flash: 'claim_opened' });
    const text = plain(html);
    expect(html).toContain('data-testid="claim-card"');
    expect(text).toContain('Не подошла · Весь заказ');
    expect(text).toContain('Ответим до');
    expect(text).toContain('Принесите деталь в упаковке в пункт выдачи');
    expect(text).toContain('Не подошла к машине');
    expect(html).toContain('data-code="claim_opened"');
    // The whole order has an open claim: no second form.
    expect(html).not.toContain('data-testid="claim-form"');
    expect(text).not.toContain('Секрет другого заказа');
    expect(text).not.toContain(order.phone);
    expect(text).not.toContain(order.phone.slice(2));
    expect(text).not.toContain(other.phone.slice(2));
    // The timeline phrases the claim.
    expect(text).toContain('Претензия принята');
  });

  it('an unknown flash code is ignored', () => {
    expect(parseOrderFlash({ flash: '<script>' })).toBeNull();
    expect(parseOrderFlash({ flash: 'install_booked' })?.section).toBe('install');
  });
});
