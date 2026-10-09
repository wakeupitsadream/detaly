// /o/<token> reads the order view and its phase 1C blocks from one snapshot
// (server/orders/order-page.ts) against local PG: a row committed by another connection while
// the page reads is in neither of them, and a failed read of the 1C blocks rolls back to its
// savepoint, hides only the blocks and leaves the order. The payment race itself (a webhook
// applied between the reads) is in pay-api.int.test.ts.
import { randomBytes, randomInt } from 'node:crypto';
import {
  createDb,
  messengerBindings,
  orderEvents,
  orderItems,
  orders,
  users,
  type Db,
  type Executor,
} from '@detaly/db';
import type { Offer } from '@detaly/domain';
import type * as Orders from '@detaly/orders';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOrderPage, type LoadOrderPageOptions } from '@/server/orders/order-page';
import { EMPTY_SERVICES } from '@/server/orders/order-services';
import { intEnv, webDatabaseUrl } from './helpers';

/** loadClaimsView (one of the 1C reads) fails with a real SQL error when asked. */
const state = vi.hoisted(() => ({ failClaims: false, claimsPid: null as number | null }));
vi.mock('@detaly/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof Orders>();
  return {
    ...actual,
    loadClaimsView: async (db: Executor, ...rest: unknown[]) => {
      const { sql } = await import('@detaly/db');
      const [backend] = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      state.claimsPid = backend?.pid ?? null;
      // division_by_zero (22012) inside the savepoint of the 1C blocks
      if (state.failClaims) await db.execute(sql`select 1 / 0`);
      return (actual.loadClaimsView as (...args: unknown[]) => unknown)(db, ...rest);
    },
  };
});

const ENV = intEnv({ APP_BASE_URL: 'http://127.0.0.1:3100' });

const KNECHT: Offer = {
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
let db: Db;

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 4 });
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  state.failClaims = false;
  state.claimsPid = null;
});

/** An order awaiting payment with one item, its user and the checkout event. */
async function insertOrder(): Promise<{ id: string; token: string; userId: string }> {
  const phone = `+79${randomInt(100_000_000, 1_000_000_000)}`;
  const [user] = await db.insert(users).values({ phone, name: 'Снимок Тестов' }).returning();
  if (!user) throw new Error('user not inserted');
  const token = randomBytes(32).toString('base64url');
  const [order] = await db
    .insert(orders)
    .values({
      userId: user.id,
      accessToken: token,
      status: 'awaiting_payment',
      paymentScheme: 'prepay',
      subtotalKop: 105_600,
      totalKop: 105_600,
      itemsHash: 'test',
      promisedDate: '2026-10-08',
      pickupCode: '482913',
    })
    .returning();
  if (!order) throw new Error('order not inserted');
  await db.insert(orderItems).values({
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
    offerSnapshot: KNECHT,
    state: 'pending',
  });
  await db.insert(orderEvents).values({
    orderId: order.id,
    type: 'checkout',
    fromStatus: 'draft',
    toStatus: 'awaiting_payment',
    actorType: 'client',
    actorId: user.id,
    payload: { scheme: 'prepay' },
  });
  return { id: order.id, token, userId: user.id };
}

function bindTelegram(userId: string) {
  return db.insert(messengerBindings).values({
    userId,
    channel: 'telegram',
    externalUserId: String(randomInt(1, 2 ** 40)),
    chatId: String(randomInt(1, 2 ** 40)),
  });
}

function options(overrides: Partial<LoadOrderPageOptions> = {}): LoadOrderPageOptions {
  return {
    view: { env: ENV, paymentsEnabled: false },
    services: () => ({ env: ENV, photosEnabled: false, maxFileMb: 10 }),
    ...overrides,
  };
}

describe('loadOrderPage', () => {
  it('reads the view and the 1C blocks from one snapshot: a row committed meanwhile is in neither', async () => {
    const order = await insertOrder();
    let viewPid: number | null = null;
    const page = await loadOrderPage(
      db,
      order.token,
      options({
        view: {
          env: ENV,
          paymentsEnabled: false,
          // The client binds Telegram from another tab while the page reads.
          afterOrderFound: async (tx) => {
            await bindTelegram(order.userId);
            const { sql } = await import('@detaly/db');
            const [backend] = await tx.execute<{ pid: number }>(
              sql`select pg_backend_pid() as pid`,
            );
            viewPid = backend?.pid ?? null;
          },
        },
      }),
    );
    expect(page?.view.id).toBe(order.id);
    expect(page?.view.status).toBe('awaiting_payment');
    // The 1C blocks read the same transaction (one connection) and its snapshot: no binding yet.
    expect(state.claimsPid).not.toBeNull();
    expect(state.claimsPid).toBe(viewPid);
    expect(page?.services.messenger).toEqual({ telegram: 'none', telegramAvailable: false });

    const next = await loadOrderPage(db, order.token, options());
    expect(next?.services.messenger?.telegram).toBe('active');
  });

  it('a failed read of the 1C blocks hides them and keeps the order', async () => {
    const order = await insertOrder();
    state.failClaims = true;
    const errors: unknown[] = [];
    const page = await loadOrderPage(
      db,
      order.token,
      options({ onServicesError: (error) => errors.push(error) }),
    );
    // The view was read before the failure; the snapshot transaction still ends cleanly.
    expect(page?.view.id).toBe(order.id);
    expect(page?.services).toEqual(EMPTY_SERVICES);
    expect(errors).toHaveLength(1);
    const cause = (errors[0] as { cause?: { code?: string } }).cause;
    expect((errors[0] as { code?: string }).code ?? cause?.code).toBe('22012');

    state.failClaims = false;
    const again = await loadOrderPage(db, order.token, options());
    expect(again?.services.messenger?.telegram).toBe('none');
  });

  it('a failure to build the 1C options hides the blocks too', async () => {
    const order = await insertOrder();
    const errors: unknown[] = [];
    const page = await loadOrderPage(
      db,
      order.token,
      options({
        services: () => {
          throw new Error('file store misconfigured');
        },
        onServicesError: (error) => errors.push(error),
      }),
    );
    expect(page?.view.id).toBe(order.id);
    expect(page?.services).toEqual(EMPTY_SERVICES);
    expect(errors).toHaveLength(1);
  });

  it('an unknown or malformed token is null', async () => {
    expect(await loadOrderPage(db, randomBytes(32).toString('base64url'), options())).toBeNull();
    expect(await loadOrderPage(db, 'not-a-token', options())).toBeNull();
  });
});
