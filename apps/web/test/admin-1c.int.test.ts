// Phase 1C admin (decision С26) against local PG and Redis with the Rossko fixtures and a memory
// FileStore: VIN requests (answer with a typo -> preview error, «Отправить» refused with 409 ->
// fixed answer -> «Отправить клиенту» -> proposal and vin_proposal in the outbox), the order card
// blocks (claims: the decision without text 422, «Принял возврат» without a photo 422, the
// refund without the return and without the owner's reason 409, the return with a photo; the
// booking confirmation; the packaging photo), the list filters and the files route under Basic
// auth.
import { randomBytes, randomInt } from 'node:crypto';
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import {
  and,
  carts,
  claims,
  createDb,
  eq,
  installBookings,
  orderItems,
  orderPhotos,
  orders,
  outbox,
  users,
  vinRequests,
  type Db,
} from '@detaly/db';
import type { Offer, OrderStatus } from '@detaly/domain';
import { createMemoryFileStore, newFileKey, type MemoryFileStore } from '@detaly/files';
import { openClaim, type EngineDeps } from '@detaly/orders';
import { createFixtureCaller } from '@detaly/rossko';
import { createVinRequest, loadVinRequestForStaff } from '@detaly/vin';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminOrder1C } from '@/components/admin/AdminOrder1C';
import { AdminVinCard } from '@/components/admin/AdminVinCard';
import { handleAdminAction, type AdminActionDeps } from '@/server/admin/actions-handler';
import { handleAdminFile } from '@/server/admin/files-handler';
import { loadAdminOrder1C } from '@/server/admin/order-1c';
import { listAdminOrders, parseAdminListQuery } from '@/server/admin/queries';
import { listAdminVinRequests, loadAdminVinRequest, parseAdminVinQuery } from '@/server/admin/vin';
import { handleAdminVinAction, type AdminVinDeps } from '@/server/admin/vin-actions-handler';
import { getCheckoutGate } from '@/server/checkout-gate';
import { uuidV7 } from '@/server/checkout/uuid';
import { createSupplierDeps, type Supplier } from '@/server/supplier';
import { intEnv, webDatabaseUrl } from './helpers';

const APP = 'http://127.0.0.1:3100';
const ADMIN = 'admin:admin-test-password';
const AUTH = `Basic ${Buffer.from(ADMIN, 'utf8').toString('base64')}`;
const env = intEnv({ ADMIN_BASIC_AUTH: ADMIN, APP_BASE_URL: APP, RKN_NOTICE_NUMBER: 'TEST-1' });

let db: Db;
let redis: Redis;
let engine: EngineDeps;
let files: MemoryFileStore;
let supplier: Supplier;
const prefixes: string[] = [];
const logged: unknown[] = [];

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 4 });
  redis = createRedis(testRedisUrl());
  engine = { db, env };
});

beforeEach(() => {
  files = createMemoryFileStore();
  const prefix = testKeyPrefix();
  prefixes.push(prefix);
  supplier = createSupplierDeps({
    env,
    db,
    redis,
    keyPrefix: prefix,
    caller: createFixtureCaller(),
  });
});

afterEach(async () => {
  for (const prefix of prefixes.splice(0)) await deleteKeysByPrefix(redis, prefix);
});

afterAll(async () => {
  await redis.quit();
  await db.close();
});

const log =
  (level: string) =>
  (...args: unknown[]): void => {
    logged.push([level, ...args]);
  };
const logger = { info: log('info'), warn: log('warn'), error: log('error') };

function orderDeps(): AdminActionDeps {
  return { engine, logger, files };
}

function vinDeps(): AdminVinDeps {
  return { db, env, supplier, logger };
}

function phone(): string {
  return `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
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

/** An order inserted directly (as the 1B admin test does), in `status`. */
async function seedOrder(status: OrderStatus) {
  const clientPhone = phone();
  const [user] = await db.insert(users).values({ phone: clientPhone }).returning();
  if (!user) throw new Error('user');
  const handed = status === 'handed' || status === 'completed';
  const [order] = await db
    .insert(orders)
    .values({
      userId: user.id,
      accessToken: randomBytes(32).toString('base64url'),
      status,
      paymentScheme: 'prepay',
      subtotalKop: 52_000,
      totalKop: 52_000,
      itemsHash: 'admin-1c-test',
      promisedDate: '2026-10-09',
      pickupCode: '482913',
      handedAt: handed ? new Date() : null,
    })
    .returning();
  if (!order) throw new Error('order');
  const [item] = await db
    .insert(orderItems)
    .values({
      orderId: order.id,
      offerKey: 'W9142:MANN:MSK7',
      searchArticleNorm: 'W9142',
      brand: 'MANN',
      article: 'W 914/2',
      name: 'Фильтр масляный',
      qty: 1,
      stockId: 'MSK7',
      isLocal: false,
      priceSupplierAtOrderKop: 40_000,
      priceClientKop: 52_000,
      markupBp: 3000,
      etaDate: '2026-10-08',
      offerSnapshot: offer('MANN', 'W 914/2'),
      state: handed ? 'handed' : 'arrived',
    })
    .returning({ id: orderItems.id });
  return {
    id: order.id,
    number: order.number,
    userId: user.id,
    phone: clientPhone,
    itemId: item?.id ?? '',
  };
}

async function jpeg(): Promise<Blob> {
  const buffer = await sharp({
    create: { width: 32, height: 24, channels: 3, background: '#33aa33' },
  })
    .jpeg()
    .toBuffer();
  return new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' });
}

function urlencoded(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return new Request(`${APP}${path}`, {
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

async function multipart(path: string, fields: Record<string, string>, photo: boolean) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  if (photo) form.append('photos', await jpeg(), 'photo.jpg');
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers: { Origin: APP, Authorization: AUTH },
    body: form,
  });
}

async function errorText(response: Response): Promise<string> {
  const html = await response.text();
  return /data-testid="admin-action-error">([^<]*)</.exec(html)?.[1] ?? html;
}

async function openDefectClaim(orderId: string, itemId: string, userId: string) {
  const result = await openClaim(engine, {
    orderId,
    itemId,
    kind: 'defect',
    text: 'Течёт по уплотнителю',
    photoKeys: [],
    via: 'web',
    requestKey: uuidV7(),
    actor: { type: 'client', id: userId },
  });
  if (!result.ok) throw new Error(`claim refused: ${result.message}`);
  return result.claimId;
}

describe('admin: VIN requests', () => {
  async function request(photo = false) {
    const gate = await getCheckoutGate({ env, db });
    if (!gate.open) throw new Error('gate closed');
    const vinRequestId = uuidV7();
    const keys: string[] = [];
    if (photo) {
      const key = newFileKey('vin', vinRequestId);
      await files.put(key, new Uint8Array(await (await jpeg()).arrayBuffer()));
      keys.push(key);
    }
    const created = await createVinRequest(db, {
      id: vinRequestId,
      vin: 'XTA210990Y1234567',
      carText: 'Lada Granta',
      needText: 'Масляный фильтр, звоните 8 912 345-67-89',
      phone: phone(),
      channel: 'sms',
      photoKeys: keys,
      consent: {
        documentVersionId: gate.docs.consentPd.id,
        textSha256: gate.docs.consentPd.sha256,
        ip: null,
        userAgent: null,
      },
      requestKey: uuidV7(),
      now: new Date(),
    });
    return { id: created.vinRequestId, keys };
  }

  const act = (id: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    handleAdminVinAction(
      urlencoded(`/api/admin/vin/${id}/actions`, fields, headers),
      id,
      vinDeps(),
    );

  it('typo -> preview error, «Отправить» 409 -> fix -> send -> proposal and vin_proposal', async () => {
    const { id } = await request();
    expect((await act(id, { action: 'take' })).status).toBe(303);

    const typo = await act(id, { action: 'preview', answer: 'MANN W9142X 1' });
    expect(typo.status).toBe(303);
    expect(decodeURIComponent(typo.headers.get('location') ?? '')).toContain('ошибок 1');
    let staff = await loadVinRequestForStaff(db, id, { revealPd: true });
    expect(staff?.preview?.errorCount).toBe(1);
    expect(staff?.preview?.lines[0]).toMatchObject({ status: 'error', reason: 'not_found' });

    const refused = await act(id, { action: 'send' });
    expect(refused.status).toBe(409);
    expect(await errorText(refused)).toContain('«Отправить клиенту» недоступна');

    const card = await loadAdminVinRequest(db, id);
    if (!card) throw new Error('card');
    const withError = renderToStaticMarkup(
      createElement(AdminVinCard, {
        card,
        done: null,
        edit: false,
        eta: (await supplier.settings.get()).eta,
      }),
    );
    expect(withError).toContain('data-reason="not_found"');
    expect(withError).not.toContain('data-testid="vin-send"');
    expect(withError).toContain(staff?.phone ?? 'phone');

    const fixed = await act(id, { action: 'preview', answer: '> Оригинал\nMANN W 914/2 1' });
    expect(decodeURIComponent(fixed.headers.get('location') ?? '')).toContain('ошибок нет');
    const sent = await act(id, { action: 'send' });
    expect(sent.status).toBe(303);
    expect(decodeURIComponent(sent.headers.get('location') ?? '')).toContain('Подборка отправлена');
    staff = await loadVinRequestForStaff(db, id, { revealPd: true });
    expect(staff?.status).toBe('offered');
    expect(staff?.proposalToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const [proposalCart] = await db
      .select()
      .from(carts)
      .where(eq(carts.id, staff?.proposalCartId ?? ''));
    expect(proposalCart?.sellerNote).toBe('Оригинал');
    const jobs = await db
      .select()
      .from(outbox)
      .where(eq(outbox.jobId, `vin:${id}:vin_proposal:1`));
    expect(jobs).toHaveLength(1);

    // A double click: the same proposal, no second message.
    const again = await act(id, { action: 'send' });
    expect(decodeURIComponent(again.headers.get('location') ?? '')).toContain('уже отправлена');

    const sentCard = await loadAdminVinRequest(db, id);
    if (!sentCard) throw new Error('card');
    const html = renderToStaticMarkup(
      createElement(AdminVinCard, { card: sentCard, done: null, edit: false, eta: null }),
    );
    expect(html).toContain(`/p/${staff?.proposalToken}`);

    expect((await act(id, { action: 'close', reason: 'клиент купил сам' })).status).toBe(303);
    const [closed] = await db.select().from(vinRequests).where(eq(vinRequests.id, id));
    expect(closed).toMatchObject({ status: 'closed', closeReason: 'клиент купил сам' });

    // Logs: ids and counts, never the phone or the answer.
    const text = JSON.stringify(logged);
    expect(text).not.toContain(staff?.phone ?? 'phone');
    expect(text).not.toContain('W9142X');
  });

  it('the list and its filter; without credentials 401, from another site 403', async () => {
    const { id } = await request();
    const list = await listAdminVinRequests(db, parseAdminVinQuery({ status: 'open' }));
    expect(list.rows.some((row) => row.id === id)).toBe(true);
    expect(parseAdminVinQuery({ status: 'bogus', page: '0' })).toEqual({ status: null, page: 1 });
    const noAuth = await handleAdminVinAction(
      urlencoded(`/api/admin/vin/${id}/actions`, { action: 'take' }, { Authorization: '' }),
      id,
      vinDeps(),
    );
    expect(noAuth.status).toBe(401);
    expect((await act(id, { action: 'take' }, { Origin: 'https://evil.example' })).status).toBe(
      403,
    );
    expect((await act(id, { action: 'nope' })).status).toBe(400);
  });

  it('files: Basic auth required, the key mask enforced, the photo served no-store', async () => {
    const { keys } = await request(true);
    const key = keys[0] ?? '';
    const segments = key.split('/');
    const get = (headers: Record<string, string>, parts = segments) =>
      handleAdminFile(
        new Request(`${APP}/api/admin/files/${parts.join('/')}`, { headers }),
        parts,
        {
          env,
          files,
        },
      );
    expect((await get({})).status).toBe(401);
    const ok = await get({ Authorization: AUTH });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    expect(ok.headers.get('cache-control')).toContain('no-store');
    expect((await sharp(new Uint8Array(await ok.arrayBuffer())).metadata()).format).toBe('jpeg');
    expect((await get({ Authorization: AUTH }, ['..', 'etc', 'passwd'])).status).toBe(404);
    expect(
      (await get({ Authorization: AUTH }, ['vin', segments[1] ?? '', `${uuidV7()}.jpg`])).status,
    ).toBe(404);
  });
});

describe('admin: claims, bookings and photos on the order card', () => {
  const act = (orderId: string, request: Request) =>
    handleAdminAction(request, orderId, orderDeps());
  const path = (orderId: string) => `/api/admin/orders/${orderId}/actions`;

  it('claim: no text 422, no photo 422, refund without return 409, return with photo, reject', async () => {
    const order = await seedOrder('handed');
    const claimId = await openDefectClaim(order.id, order.itemId, order.userId);

    const noText = await act(
      order.id,
      urlencoded(path(order.id), { action: 'crej', claimId, text: '' }),
    );
    expect(noText.status).toBe(422);
    expect(await errorText(noText)).toContain('Напишите ответ клиенту');

    const noPhoto = await act(
      order.id,
      await multipart(path(order.id), { action: 'cret', claimId }, false),
    );
    expect(noPhoto.status).toBe(422);
    expect(await errorText(noPhoto)).toContain('Приложите фото');

    const refund = await act(
      order.id,
      urlencoded(path(order.id), { action: 'cref', claimId, text: 'Вернём деньги', confirm: 'on' }),
    );
    expect(refund.status).toBe(409);
    expect((await errorText(refund)).length).toBeGreaterThan(5);
    const unconfirmed = await act(
      order.id,
      urlencoded(path(order.id), { action: 'cref', claimId, text: 'Вернём деньги' }),
    );
    expect(unconfirmed.status).toBe(400);

    const comp = await act(
      order.id,
      urlencoded(path(order.id), { action: 'claim_comp', claimId, amountRub: '100' }),
    );
    expect(comp.status).toBe(409);
    expect(await errorText(comp)).toContain('только по претензии о просрочке');

    const accepted = await act(
      order.id,
      await multipart(path(order.id), { action: 'cret', claimId }, true),
    );
    expect(accepted.status).toBe(303);
    const [claim] = await db.select().from(claims).where(eq(claims.id, claimId));
    expect(claim?.returnAcceptedAt).not.toBeNull();
    const [photo] = await db
      .select()
      .from(orderPhotos)
      .where(and(eq(orderPhotos.orderId, order.id), eq(orderPhotos.kind, 'return')));
    expect(photo?.claimId).toBe(claimId);
    expect(files.keys()).toContain(photo?.s3Key);

    // A claim of another order is not a target here.
    const other = await seedOrder('handed');
    const foreign = await act(
      other.id,
      urlencoded(path(other.id), { action: 'crej', claimId, text: 'Нет' }),
    );
    expect(foreign.status).toBe(404);

    const list = await listAdminOrders(db, parseAdminListQuery({ status: 'claims_open' }));
    expect(parseAdminListQuery({ status: 'claims_open' }).status).toBe('claims_open');
    expect(list.invalidSearch).toBe(false);

    const data = await loadAdminOrder1C(engine, order.id);
    if (!data) throw new Error('1C data');
    const html = renderToStaticMarkup(
      createElement(AdminOrder1C, {
        orderId: order.id,
        data,
        items: [{ id: order.itemId, title: 'MANN W 914/2' }],
        canOpenClaim: true,
      }),
    );
    expect(html).toContain('Течёт по уплотнителю');
    expect(html).toContain('data-testid="admin-return-photo"');
    expect(html).toContain('/print/pamyatka-vozvrat.pdf');
    expect(html).toContain('/print/akt-vydachi.pdf');
    expect(html).toContain('data-action="crej"');

    const rejected = await act(
      order.id,
      urlencoded(path(order.id), { action: 'crej', claimId, text: 'Следов брака не нашли' }),
    );
    expect(rejected.status).toBe(303);
    const [decided] = await db.select().from(claims).where(eq(claims.id, claimId));
    expect(decided).toMatchObject({ decision: 'reject', decisionText: 'Следов брака не нашли' });
    expect(decided?.closedAt).not.toBeNull();
  });

  it('claim opened from the admin; the same request key twice is one claim', async () => {
    const order = await seedOrder('handed');
    const requestKey = uuidV7();
    const fields = {
      action: 'claim_open',
      kind: 'defect',
      itemId: order.itemId,
      text: 'со слов клиента',
      requestKey,
    };
    expect((await act(order.id, urlencoded(path(order.id), fields))).status).toBe(303);
    expect((await act(order.id, urlencoded(path(order.id), fields))).status).toBe(303);
    const rows = await db.select().from(claims).where(eq(claims.orderId, order.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'defect', openedVia: 'admin' });
    const bad = await act(order.id, urlencoded(path(order.id), { ...fields, kind: 'nope' }));
    expect(bad.status).toBe(422);
  });

  it('booking: «Подтвердить запись» confirms it; the filter finds a requested one', async () => {
    const order = await seedOrder('ready');
    const [booking] = await db
      .insert(installBookings)
      .values({
        orderId: order.id,
        userId: order.userId,
        slotAt: new Date(Date.now() + 3 * 86_400_000),
        status: 'requested',
        requestKey: uuidV7(),
        createdVia: 'web',
      })
      .returning({ id: installBookings.id });
    const list = await listAdminOrders(db, parseAdminListQuery({ status: 'install_requested' }));
    expect(list.rows.some((row) => row.id === order.id) || list.hasNext).toBe(true);
    const confirmed = await act(
      order.id,
      urlencoded(path(order.id), { action: 'bconf', bookingId: booking?.id ?? '' }),
    );
    expect(confirmed.status).toBe(303);
    const [row] = await db
      .select()
      .from(installBookings)
      .where(eq(installBookings.id, booking?.id ?? ''));
    expect(row?.status).toBe('confirmed');
  });

  it('packaging photo by upload; without photo storage the upload is refused', async () => {
    const order = await seedOrder('ready');
    const stored = await act(
      order.id,
      await multipart(path(order.id), { action: 'pphoto', photoKind: 'packaging' }, true),
    );
    expect(stored.status).toBe(303);
    const [photo] = await db
      .select()
      .from(orderPhotos)
      .where(and(eq(orderPhotos.orderId, order.id), eq(orderPhotos.kind, 'packaging')));
    expect(photo?.s3Key).toMatch(new RegExp(`^order/${order.id}/`));

    const off = await handleAdminAction(
      await multipart(path(order.id), { action: 'pphoto' }, true),
      order.id,
      { engine, logger },
    );
    expect(off.status).toBe(413);
    expect(await errorText(off)).toContain('Хранилище фото не настроено');
  });
});
