// rossko queue (docs/phase-1b-implementation.md section 11, decisions Б12–Б15): recheck bypassing
// the cache, GetCheckout with double-submit protection, recovery after an ambiguous failure and
// the Rossko invoice. Runs against the `_worker` database and a fixture caller that counts calls
// (no network). Covers Verification «Фаза 1B» steps 5, 6, 22 and 23.
import { randomBytes, randomInt } from 'node:crypto';
import { bullJobId, parseEnv, type Env } from '@detaly/config';
import { minimalEnvSource, testRedisUrl } from '@detaly/config/testing';
import {
  eq,
  orderEvents,
  orderItems,
  orders,
  outbox,
  payments,
  settings,
  supplierOrderItems,
  supplierOrders,
  supplierReturns,
  users,
} from '@detaly/db';
import { promisedDate, type Offer } from '@detaly/domain';
import {
  applyTransition,
  loadOrderSettings,
  performStaffAction,
  type OrderItemRow,
} from '@detaly/orders';
import {
  createFixtureCaller,
  createRosskoClient,
  createSearchCache,
  createUnlimitedLimiter,
  FIXTURE_LOCAL_STOCK_IDS,
  RosskoCallError,
  type CheckoutFixtureVariant,
  type OrdersListFixtureVariant,
  type RosskoCaller,
  type RosskoClient,
  type RosskoMethod,
} from '@detaly/rossko';
import { UnrecoverableError, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  processRossko,
  RECHECK_UNAVAILABLE_NOTE,
  RECOVER_DELAY_MS,
  recoverDelayMs,
  UNMATCHED_ITEM_ERROR,
} from '../src/jobs/rossko';
import { createTestDeps, workerTestDatabaseUrl, type TestDeps } from './helpers/test-deps';

const T0 = new Date('2026-10-05T07:00:00.000Z');
const ETA = '2026-10-08';
const ROSSKO_ENV = {
  ROSSKO_ALLOW_CHECKOUT: 'true',
  ROSSKO_DELIVERY_ID: 'fx-delivery',
  ROSSKO_PAYMENT_ID: 'fx-payment',
};

// ---------------------------------------------------------------------------------------------
// Rossko: fixture caller that counts calls, optional echo GetCheckout and search failures
// ---------------------------------------------------------------------------------------------

interface CallerOptions {
  priceFactorBp?: number;
  checkoutVariant?: CheckoutFixtureVariant;
  ordersList?: OrdersListFixtureVariant;
  /** GetCheckout answers with exactly the requested parts (Rossko order 71000001). */
  echoCheckout?: boolean;
  /** Every GetSearch throws this. */
  searchError?: Error;
}

interface CountingCaller extends RosskoCaller {
  calls: { method: RosskoMethod; args: Record<string, unknown> }[];
  count(method: RosskoMethod): number;
}

function partsOf(args: Record<string, unknown>): Record<string, unknown>[] {
  const parts = (args.PARTS as { Part?: unknown } | undefined)?.Part;
  return (Array.isArray(parts) ? parts : parts ? [parts] : []) as Record<string, unknown>[];
}

function countingCaller(options: CallerOptions = {}): CountingCaller {
  const inner = createFixtureCaller({
    priceFactorBp: options.priceFactorBp,
    checkoutVariant: options.checkoutVariant,
    ordersList: options.ordersList,
    now: () => T0,
  });
  const calls: CountingCaller['calls'] = [];
  return {
    calls,
    count: (method) => calls.filter((call) => call.method === method).length,
    async call(method, args) {
      calls.push({ method, args });
      if (method === 'GetSearch' && options.searchError) throw options.searchError;
      if (method === 'GetCheckout' && options.echoCheckout) {
        return {
          CheckoutResult: {
            success: true,
            message: '',
            OrderIDS: { id: '71000001' },
            DeliveryCost: { cost: '0.00' },
            ItemsList: {
              Item: partsOf(args).map((part) => ({
                partnumber: part.partnumber,
                brand: part.brand,
                stock: part.stock,
                count: part.count,
                price: '400.00',
              })),
            },
          },
        };
      }
      return inner.call(method, args);
    },
  };
}

interface Harness {
  t: TestDeps;
  caller: CountingCaller;
  client: RosskoClient;
}

/** WorkerDeps with a fixed clock, the Rossko env and a counting fixture client sharing a cache. */
async function harness(
  options: CallerOptions & { env?: Record<string, string>; allowCheckout?: boolean } = {},
): Promise<Harness> {
  const envSource = { ...ROSSKO_ENV, ...options.env };
  const env: Env = parseEnv(
    minimalEnvSource({
      DATABASE_URL: workerTestDatabaseUrl(),
      REDIS_URL: testRedisUrl(),
      ...envSource,
    }),
  );
  const t = await createTestDeps({ env, now: () => T0 });
  const caller = countingCaller(options);
  const client = createRosskoClient({
    caller,
    key1: 'test-key1',
    key2: 'test-key2',
    deliveryId: env.ROSSKO_DELIVERY_ID ?? null,
    paymentId: env.ROSSKO_PAYMENT_ID ?? null,
    localStockIds: FIXTURE_LOCAL_STOCK_IDS,
    limiter: createUnlimitedLimiter(),
    cache: createSearchCache(t.deps.redis, { keyPrefix: t.deps.keyPrefix }),
    allowCheckout: options.allowCheckout ?? env.ROSSKO_ALLOW_CHECKOUT,
  });
  t.deps.rossko = client;
  return { t, caller, client };
}

/** Unscaled fixture offers (no cache, no counting). */
const plainClient = createRosskoClient({
  caller: createFixtureCaller(),
  key1: 'k1',
  key2: 'k2',
  deliveryId: 'fx-delivery',
  paymentId: 'fx-payment',
  localStockIds: FIXTURE_LOCAL_STOCK_IDS,
  limiter: createUnlimitedLimiter(),
  allowCheckout: false,
});

async function fixtureOffer(article: string, brand: string, stockId: string): Promise<Offer> {
  const { offers } = await plainClient.search(article);
  const offer = offers.find(
    (o) => o.brand === brand && o.stock.stockId === stockId && o.articleNorm === article,
  );
  if (!offer) throw new Error(`no fixture offer ${brand} ${article} @${stockId}`);
  return offer;
}

// ---------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------

interface SeedLine {
  article: string;
  brand: string;
  stockId: string;
  qty: number;
  etaDate?: string;
}

const OK_LINES: SeedLine[] = [
  { article: 'OC90', brand: 'Knecht', stockId: 'ORB1', qty: 2, etaDate: '2026-10-08' },
  { article: 'GDB1330', brand: 'TRW', stockId: 'ORB1', qty: 1, etaDate: '2026-10-09' },
];

/** Lines of GetCheckout.itemErrors: OC 90 is ordered, W 914/2 is refused. */
const ITEM_ERROR_LINES: SeedLine[] = [
  { article: 'OC90', brand: 'Knecht', stockId: 'MSK7', qty: 1 },
  { article: 'W9142', brand: 'MANN-FILTER', stockId: 'MSK7', qty: 1 },
];

interface Seeded {
  orderId: string;
  number: string;
  phone: string;
  itemIds: string[];
}

function clientPrice(supplierKop: number): number {
  return Math.ceil((supplierKop * 12_800) / 1_000_000) * 100;
}

/** A prepay order with a succeeded payment, directly in `status`. */
async function seedOrder(
  t: TestDeps,
  lines: readonly SeedLine[],
  status: 'confirmed' | 'ordered_at_supplier' = 'confirmed',
): Promise<Seeded> {
  const db = t.deps.db;
  const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  const offers = await Promise.all(lines.map((l) => fixtureOffer(l.article, l.brand, l.stockId)));
  const rows = lines.map((line, i) => {
    const offer = offers[i] as Offer;
    return {
      offerKey: `${offer.articleNorm}:${offer.brand}:${offer.stock.stockId}`,
      searchArticleNorm: line.article,
      brand: offer.brand,
      article: offer.article,
      name: offer.name,
      qty: line.qty,
      stockId: offer.stock.stockId,
      isLocal: offer.stock.isLocal,
      priceSupplierAtOrderKop: offer.priceSupplierKop,
      priceClientKop: clientPrice(offer.priceSupplierKop),
      markupBp: 2800,
      etaDate: line.etaDate ?? ETA,
      offerSnapshot: offer,
      state: status === 'confirmed' ? ('pending' as const) : ('ordered' as const),
    };
  });
  const subtotal = rows.reduce((sum, row) => sum + row.priceClientKop * row.qty, 0);
  const [user] = await db.insert(users).values({ phone }).returning({ id: users.id });
  const [order] = await db
    .insert(orders)
    .values({
      userId: (user as { id: string }).id,
      accessToken: randomBytes(32).toString('base64url'),
      status,
      paymentScheme: 'prepay',
      subtotalKop: subtotal,
      totalKop: subtotal,
      itemsHash: 'test',
      confirmedAt: T0,
    })
    .returning({ id: orders.id, number: orders.number });
  const { id: orderId, number } = order as { id: string; number: string };
  const inserted = await db
    .insert(orderItems)
    .values(rows.map((row) => ({ ...row, orderId })))
    .returning({ id: orderItems.id });
  await db.insert(payments).values({
    orderId,
    kind: 'prepayment',
    status: 'succeeded',
    amountKop: subtotal,
    idempotenceKey: randomBytes(16).toString('hex'),
    providerPaymentId: `pay-${randomBytes(8).toString('hex')}`,
    paidAt: T0,
  });
  const itemIds = inserted.map((row) => row.id);
  if (status === 'ordered_at_supplier') {
    const [so] = await db
      .insert(supplierOrders)
      .values({ orderId, attemptNo: 1, status: 'created', rosskoOrderIds: ['70000001'] })
      .returning({ id: supplierOrders.id });
    await db
      .insert(supplierOrderItems)
      .values(
        itemIds.map((orderItemId) => ({ supplierOrderId: (so as { id: string }).id, orderItemId })),
      );
  }
  return { orderId, number, phone, itemIds };
}

async function orderOf(t: TestDeps, orderId: string) {
  const [row] = await t.deps.db.select().from(orders).where(eq(orders.id, orderId));
  if (!row) throw new Error('order not found');
  return row;
}

async function itemsOf(t: TestDeps, orderId: string): Promise<OrderItemRow[]> {
  return t.deps.db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.createdAt, orderItems.id);
}

async function supplierOrdersOf(t: TestDeps, orderId: string) {
  return t.deps.db
    .select()
    .from(supplierOrders)
    .where(eq(supplierOrders.orderId, orderId))
    .orderBy(supplierOrders.attemptNo);
}

async function eventsOf(t: TestDeps, orderId: string) {
  return t.deps.db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(orderEvents.createdAt, orderEvents.id);
}

async function outboxRow(t: TestDeps, key: string) {
  const [row] = await t.deps.db.select().from(outbox).where(eq(outbox.jobId, key));
  return row ?? null;
}

/** A BullMQ-like job built from an outbox row, as the dispatcher would add it. */
async function jobFromOutbox(
  t: TestDeps,
  key: string,
  extra: { attemptsMade?: number; attempts?: number } = {},
): Promise<Job> {
  const row = await outboxRow(t, key);
  if (!row) throw new Error(`no outbox row ${key}`);
  return {
    id: bullJobId(key),
    name: row.name,
    data: { ...row.data, outboxKey: key },
    attemptsMade: extra.attemptsMade ?? 0,
    opts: { attempts: extra.attempts ?? 1 },
  } as unknown as Job;
}

/** «Проверить и заказать» as a seller: journal recheck_requested + rossko/recheck. */
async function pressRecheck(t: TestDeps, orderId: string): Promise<string> {
  const result = await performStaffAction(t.deps.engine, {
    staff: { id: null, role: 'seller', via: 'admin' },
    action: 'recheck',
    targetId: orderId,
  });
  expect(result.ok).toBe(true);
  const [requested] = (await eventsOf(t, orderId)).filter((e) => e.type === 'recheck_requested');
  if (!requested) throw new Error('no recheck_requested');
  return `recheck:${requested.id}`;
}

async function runRecheck(t: TestDeps, orderId: string) {
  const key = await pressRecheck(t, orderId);
  return processRossko(await jobFromOutbox(t, key, { attempts: 3 }), t.deps);
}

function checkoutKey(supplierOrderId: string): string {
  return `checkout:${supplierOrderId}`;
}

async function runCheckout(t: TestDeps, supplierOrderId: string) {
  return processRossko(await jobFromOutbox(t, checkoutKey(supplierOrderId)), t.deps);
}

/** Journal, outbox and supplier rows of an order never carry the client phone. */
async function expectNoPhone(t: TestDeps, seeded: Seeded): Promise<void> {
  const digits = seeded.phone.replace(/^\+/, '');
  const events = await eventsOf(t, seeded.orderId);
  const rows = await supplierOrdersOf(t, seeded.orderId);
  const box = await t.deps.db.select().from(outbox);
  const text = JSON.stringify([events, rows, box.filter((r) => r.data.orderId === seeded.orderId)]);
  expect(text).not.toContain(digits);
}

// ---------------------------------------------------------------------------------------------

const enabled = Boolean(inject('workerDatabaseUrl'));

describe.skipIf(!enabled)('rossko queue', () => {
  const open: Harness[] = [];
  const restore: (() => Promise<void>)[] = [];

  async function make(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
    const h = await harness(options);
    open.push(h);
    return h;
  }

  beforeAll(() => {
    expect(RECOVER_DELAY_MS).toBeGreaterThanOrEqual(15_000);
  });

  afterAll(async () => {
    for (const undo of restore.reverse()) await undo();
    for (const h of open) await h.t.close();
  });

  describe('Verification 5: recheck bypassing the cache', () => {
    it('+1% passes: ordering, one sending supplier order and its checkout job, then ordered', async () => {
      const h = await make({ priceFactorBp: 10_100 });
      const seeded = await seedOrder(h.t, OK_LINES);
      // A warm cache with the old prices: the recheck must not read it.
      const warm = createRosskoClient({
        caller: createFixtureCaller(),
        key1: 'k1',
        key2: 'k2',
        deliveryId: 'fx-delivery',
        localStockIds: FIXTURE_LOCAL_STOCK_IDS,
        limiter: createUnlimitedLimiter(),
        cache: createSearchCache(h.t.deps.redis, { keyPrefix: h.t.deps.keyPrefix }),
        allowCheckout: false,
      });
      await warm.search('OC90');
      await warm.search('GDB1330');
      expect((await h.client.search('OC90')).fromCache).toBe(true);
      const before = h.caller.count('GetSearch');

      const result = await runRecheck(h.t, seeded.orderId);
      expect(result).toMatchObject({ outcome: 'applied', to: 'ordering', allAvailable: true });
      // +1% per unit, rounded half up in kopecks: 100..101 bp (a cached answer would give 0).
      const drift = (result as { priceDriftBp: number }).priceDriftBp;
      expect(drift).toBeGreaterThanOrEqual(100);
      expect(drift).toBeLessThanOrEqual(101);
      // One GetSearch per unique article, past the warm cache.
      expect(h.caller.count('GetSearch') - before).toBe(2);
      expect(
        h.caller.calls.filter((c) => c.method === 'GetSearch').map((c) => c.args.text),
      ).toEqual(expect.arrayContaining(['OC90', 'GDB1330']));

      const order = await orderOf(h.t, seeded.orderId);
      expect(order.status).toBe('ordering');
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      expect(attempt).toMatchObject({ attemptNo: 1, status: 'sending', calledAt: null });
      const links = await h.t.deps.db
        .select()
        .from(supplierOrderItems)
        .where(eq(supplierOrderItems.supplierOrderId, attempt!.id));
      expect(links.map((l) => l.orderItemId).sort()).toEqual([...seeded.itemIds].sort());
      expect(await outboxRow(h.t, checkoutKey(attempt!.id))).toMatchObject({
        queue: 'rossko',
        name: 'checkout',
      });

      const journal = (await eventsOf(h.t, seeded.orderId)).find(
        (e) => e.type === 'recheck_result',
      );
      expect(journal?.payload).toMatchObject({ ok: true, priceDriftBp: drift, allAvailable: true });
      expect((journal?.payload.items as unknown[]).length).toBe(2);

      const checkout = await runCheckout(h.t, attempt!.id);
      expect(checkout).toMatchObject({ outcome: 'created', itemErrors: 0 });
      expect(h.caller.count('GetCheckout')).toBe(1);
      const sent = h.caller.calls.find((c) => c.method === 'GetCheckout')!.args;
      expect(sent.comment).toBe(`${seeded.number}/1`);
      expect(partsOf(sent)).toHaveLength(2);
      expect(JSON.stringify(sent)).not.toContain('contact');

      const after = await orderOf(h.t, seeded.orderId);
      expect(after.status).toBe('ordered_at_supplier');
      expect(after.promisedDate).not.toBeNull();
      expect((await itemsOf(h.t, seeded.orderId)).map((i) => i.state)).toEqual([
        'ordered',
        'ordered',
      ]);
      const [created] = await supplierOrdersOf(h.t, seeded.orderId);
      expect(created).toMatchObject({
        status: 'created',
        rosskoOrderIds: ['70000001'],
        deliveryCostKop: 0,
        invoiceNumber: null,
        error: null,
      });
      expect(created!.calledAt).toEqual(T0);
      expect(created!.request).toMatchObject({ comment: `${seeded.number}/1` });
      // The client hears «заказано» through the engine's notify outbox.
      const ordered = (await eventsOf(h.t, seeded.orderId)).find(
        (e) => e.type === 'supplier_checkout_succeeded',
      );
      expect(await outboxRow(h.t, `notify:${ordered!.id}:ordered`)).not.toBeNull();
      await expectNoPhone(h.t, seeded);
    });

    it('+10% fails: needs_attention with alternatives, no supplier order', async () => {
      const h = await make({ priceFactorBp: 11_000 });
      const seeded = await seedOrder(h.t, OK_LINES);
      const result = await runRecheck(h.t, seeded.orderId);
      expect(result).toMatchObject({
        outcome: 'applied',
        to: 'needs_attention',
        priceDriftBp: 1000,
      });

      const order = await orderOf(h.t, seeded.orderId);
      expect(order.status).toBe('needs_attention');
      expect(order.attentionReason).toBe('price_drift');
      expect(await supplierOrdersOf(h.t, seeded.orderId)).toEqual([]);
      expect(h.caller.count('GetCheckout')).toBe(0);

      const journal = (await eventsOf(h.t, seeded.orderId)).find(
        (e) => e.type === 'recheck_result',
      );
      const items = journal?.payload.items as {
        orderItemId: string;
        driftBp: number;
        alternatives: { offerKey: string; priceClientKop: number; marginBp: number }[];
      }[];
      const oc90 = items.find((i) => i.orderItemId === seeded.itemIds[0]);
      expect(oc90?.driftBp).toBe(1000);
      expect(oc90?.alternatives.length).toBeGreaterThan(0);
      for (const alt of oc90?.alternatives ?? []) {
        expect(alt.marginBp).toBeGreaterThanOrEqual(1000);
      }
      const transition = (await eventsOf(h.t, seeded.orderId)).find(
        (e) => e.type === 'supplier_order_requested',
      );
      expect(transition?.toStatus).toBe('needs_attention');
      expect(await outboxRow(h.t, `notify:${transition!.id}:staff_problem`)).not.toBeNull();
      await expectNoPhone(h.t, seeded);
    });

    it('skips an order that is no longer confirmed without calling Rossko', async () => {
      const h = await make();
      const seeded = await seedOrder(h.t, OK_LINES);
      const key = await pressRecheck(h.t, seeded.orderId);
      await h.t.deps.db
        .update(orders)
        .set({ status: 'needs_attention' })
        .where(eq(orders.id, seeded.orderId));
      const result = await processRossko(await jobFromOutbox(h.t, key), h.t.deps);
      expect(result).toEqual({ outcome: 'skipped', reason: 'status' });
      expect(h.caller.count('GetSearch')).toBe(0);
    });

    it('a repeated recheck job after the transition does nothing', async () => {
      const h = await make();
      const seeded = await seedOrder(h.t, OK_LINES);
      const key = await pressRecheck(h.t, seeded.orderId);
      const job = await jobFromOutbox(h.t, key);
      expect(await processRossko(job, h.t.deps)).toMatchObject({ outcome: 'applied' });
      expect(await processRossko(job, h.t.deps)).toEqual({ outcome: 'skipped', reason: 'status' });
      expect((await supplierOrdersOf(h.t, seeded.orderId)).length).toBe(1);
      expect(h.caller.count('GetSearch')).toBe(2);
    });

    it('Rossko errors are retried, the last attempt posts «Rossko не ответил»', async () => {
      const h = await make({
        searchError: new RosskoCallError('GetSearch', 'socket hang up', { code: 'ECONNRESET' }),
      });
      const seeded = await seedOrder(h.t, OK_LINES);
      const key = await pressRecheck(h.t, seeded.orderId);

      await expect(
        processRossko(await jobFromOutbox(h.t, key, { attemptsMade: 0, attempts: 3 }), h.t.deps),
      ).rejects.toBeInstanceOf(RosskoCallError);
      await expect(
        processRossko(await jobFromOutbox(h.t, key, { attemptsMade: 1, attempts: 3 }), h.t.deps),
      ).rejects.toBeInstanceOf(RosskoCallError);
      expect(h.t.fakes.sellerCards.calls).toEqual([]);

      const last = await processRossko(
        await jobFromOutbox(h.t, key, { attemptsMade: 2, attempts: 3 }),
        h.t.deps,
      );
      expect(last).toMatchObject({ outcome: 'supplier_unavailable' });
      expect((await orderOf(h.t, seeded.orderId)).status).toBe('confirmed');
      const journal = (await eventsOf(h.t, seeded.orderId)).find(
        (e) => e.type === 'recheck_result',
      );
      expect(journal?.payload).toMatchObject({ ok: false, error: 'supplier_unavailable' });
      expect(h.t.fakes.sellerCards.calls).toEqual([
        {
          method: 'post',
          input: {
            orderId: seeded.orderId,
            template: null,
            orderEventId: journal!.id,
            note: RECHECK_UNAVAILABLE_NOTE,
          },
        },
      ]);
      // «Проверить и заказать» works again.
      expect(
        (
          await performStaffAction(h.t.deps.engine, {
            staff: { id: null, role: 'seller', via: 'admin' },
            action: 'recheck',
            targetId: seeded.orderId,
          })
        ).ok,
      ).toBe(true);
    });
  });

  describe('Verification 6: itemErrors', () => {
    it('one of two items refused: needs_attention, the item stays pending with its error', async () => {
      const h = await make({ checkoutVariant: 'itemErrors' });
      const seeded = await seedOrder(h.t, ITEM_ERROR_LINES);
      expect(await runRecheck(h.t, seeded.orderId)).toMatchObject({ to: 'ordering' });
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);

      const result = await runCheckout(h.t, attempt!.id);
      expect(result).toMatchObject({ outcome: 'created', itemErrors: 1 });
      const order = await orderOf(h.t, seeded.orderId);
      expect(order.status).toBe('needs_attention');
      expect(order.attentionReason).toBe('item_errors');

      const [oc90, w9142] = await itemsOf(h.t, seeded.orderId);
      expect(oc90).toMatchObject({ state: 'ordered', supplierItemError: null });
      expect(w9142?.state).toBe('pending');
      expect(w9142?.supplierItemError).toMatchObject({
        article: 'W 914/2',
        message: 'Недостаточно товара на складе',
      });
      const [row] = await supplierOrdersOf(h.t, seeded.orderId);
      expect(row).toMatchObject({
        status: 'created',
        rosskoOrderIds: ['70000002'],
        deliveryCostKop: 30_000,
      });
      expect(row?.itemErrors).toEqual([expect.objectContaining({ article: 'W 914/2' })]);
      const transition = (await eventsOf(h.t, seeded.orderId)).find(
        (e) => e.type === 'supplier_checkout_succeeded',
      );
      expect(transition).toMatchObject({ toStatus: 'needs_attention' });
      expect(await outboxRow(h.t, `notify:${transition!.id}:staff_problem`)).not.toBeNull();
      await expectNoPhone(h.t, seeded);
    });
  });

  describe('Verification 22: damaged on receipt', () => {
    it('claim to Rossko and a GetCheckout of the replacement item only', async () => {
      const h = await make({ echoCheckout: true });
      const seeded = await seedOrder(h.t, OK_LINES, 'ordered_at_supplier');
      const damaged = await applyTransition(h.t.deps.engine, {
        orderId: seeded.orderId,
        event: 'item_damaged_on_receipt',
        actor: { type: 'staff', id: null, staffRole: 'seller' },
        itemId: seeded.itemIds[0],
      });
      expect(damaged).toMatchObject({ ok: true, to: 'ordered_at_supplier' });

      const claims = await h.t.deps.db
        .select()
        .from(supplierReturns)
        .where(eq(supplierReturns.orderItemId, seeded.itemIds[0]!));
      expect(claims).toEqual([expect.objectContaining({ kind: 'claim', status: 'requested' })]);
      const items = await itemsOf(h.t, seeded.orderId);
      const old = items.find((i) => i.id === seeded.itemIds[0]);
      const replacement = items.find((i) => i.id === old?.replacedByItemId);
      expect(old?.state).toBe('replaced');
      expect(replacement).toMatchObject({ state: 'pending', brand: 'Knecht', qty: 2 });

      const attempts = await supplierOrdersOf(h.t, seeded.orderId);
      const second = attempts.find((a) => a.attemptNo === 2);
      expect(second?.status).toBe('sending');

      expect(await runCheckout(h.t, second!.id)).toMatchObject({
        outcome: 'created',
        itemErrors: 0,
      });
      const sent = h.caller.calls.find((c) => c.method === 'GetCheckout')!.args;
      expect(sent.comment).toBe(`${seeded.number}/2`);
      expect(partsOf(sent)).toEqual([expect.objectContaining({ brand: 'Knecht', count: 2 })]);

      expect((await orderOf(h.t, seeded.orderId)).status).toBe('ordered_at_supplier');
      expect(
        (await itemsOf(h.t, seeded.orderId)).find((i) => i.id === replacement!.id)?.state,
      ).toBe('ordered');
      const [, settled] = await supplierOrdersOf(h.t, seeded.orderId);
      expect(settled).toMatchObject({ status: 'created', rosskoOrderIds: ['71000001'] });
      expect(h.t.fakes.alerts.calls).toEqual([]);
    });
  });

  describe('Verification 23: rossko.prepay_invoice', () => {
    it('awaiting_supplier_invoice with the invoice, «Счёт оплачен» → ordered_at_supplier', async () => {
      const h = await make();
      const [previous] = await h.t.deps.db
        .select()
        .from(settings)
        .where(eq(settings.key, 'rossko.prepay_invoice'));
      const setPrepay = (value: unknown) =>
        h.t.deps.db
          .insert(settings)
          .values({ key: 'rossko.prepay_invoice', value, updatedBy: 'test' })
          .onConflictDoUpdate({ target: settings.key, set: { value } });
      const undo = async () => {
        if (previous) await setPrepay(previous.value);
        else await h.t.deps.db.delete(settings).where(eq(settings.key, 'rossko.prepay_invoice'));
      };
      restore.push(undo);
      await setPrepay(true);
      try {
        const seeded = await seedOrder(h.t, OK_LINES);
        expect(await runRecheck(h.t, seeded.orderId)).toMatchObject({ to: 'ordering' });
        const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
        expect(await runCheckout(h.t, attempt!.id)).toMatchObject({ outcome: 'created' });

        const order = await orderOf(h.t, seeded.orderId);
        expect(order.status).toBe('awaiting_supplier_invoice');
        const eta = (await loadOrderSettings(h.t.deps.db, h.t.deps.env)).eta;
        expect(eta.prepayInvoice).toBe(true);
        const withLag = promisedDate(['2026-10-08', '2026-10-09'], eta);
        const withoutLag = promisedDate(['2026-10-08', '2026-10-09'], {
          ...eta,
          prepayInvoice: false,
        });
        expect(order.promisedDate).toBe(withLag);
        expect(withLag > withoutLag).toBe(eta.invoiceLagDays > 0);

        const [row] = await supplierOrdersOf(h.t, seeded.orderId);
        // 2 × 412.50 + 1 × 1834.00 + delivery 0.00
        expect(row).toMatchObject({
          status: 'created',
          invoiceNumber: '70000001',
          invoiceAmountKop: 265_900,
          invoicePaidAt: null,
        });
        const transition = (await eventsOf(h.t, seeded.orderId)).find(
          (e) => e.type === 'supplier_checkout_succeeded',
        );
        expect(
          await outboxRow(h.t, `notify:${transition!.id}:staff_supplier_invoice_due`),
        ).not.toBeNull();

        const paid = await performStaffAction(h.t.deps.engine, {
          staff: { id: null, role: 'owner', via: 'admin' },
          action: 'invpaid',
          targetId: seeded.orderId,
          input: { paymentRef: 'п/п 15 от 05.10.2026' },
        });
        expect(paid.ok).toBe(true);
        expect((await orderOf(h.t, seeded.orderId)).status).toBe('ordered_at_supplier');
        const [paidRow] = await supplierOrdersOf(h.t, seeded.orderId);
        expect(paidRow?.invoicePaidAt).not.toBeNull();
        expect(paidRow?.invoicePaymentRef).toBe('п/п 15 от 05.10.2026');
      } finally {
        await undo();
        restore.splice(restore.indexOf(undo), 1);
      }
    });
  });

  describe('ROSSKO_ALLOW_CHECKOUT=false', () => {
    it('fails the attempt with checkout_disabled and never calls GetCheckout', async () => {
      const h = await make({ env: { ROSSKO_ALLOW_CHECKOUT: 'false' } });
      const seeded = await seedOrder(h.t, OK_LINES);
      expect(await runRecheck(h.t, seeded.orderId)).toMatchObject({ to: 'ordering' });
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);

      expect(await runCheckout(h.t, attempt!.id)).toMatchObject({
        outcome: 'failed',
        reason: 'checkout_disabled',
      });
      expect(h.caller.count('GetCheckout')).toBe(0);
      const order = await orderOf(h.t, seeded.orderId);
      expect(order).toMatchObject({
        status: 'needs_attention',
        attentionReason: 'checkout_disabled',
      });
      const [row] = await supplierOrdersOf(h.t, seeded.orderId);
      expect(row).toMatchObject({ status: 'failed', calledAt: null });
      expect(row?.error).toMatch(/ROSSKO_ALLOW_CHECKOUT=false/);
      expect((await itemsOf(h.t, seeded.orderId)).every((i) => i.state === 'pending')).toBe(true);
    });

    it('a client built with allowCheckout=false is refused the same way (0 GetCheckout)', async () => {
      const h = await make({ allowCheckout: false });
      const seeded = await seedOrder(h.t, OK_LINES);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      expect(await runCheckout(h.t, attempt!.id)).toMatchObject({
        outcome: 'failed',
        reason: 'checkout_disabled',
      });
      expect(h.caller.count('GetCheckout')).toBe(0);
      expect((await orderOf(h.t, seeded.orderId)).attentionReason).toBe('checkout_disabled');
    });
  });

  describe('double submit (decision Б13)', () => {
    it('the checkout job run twice calls GetCheckout once', async () => {
      const h = await make();
      const seeded = await seedOrder(h.t, OK_LINES);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      const job = await jobFromOutbox(h.t, checkoutKey(attempt!.id));

      expect(await processRossko(job, h.t.deps)).toMatchObject({ outcome: 'created' });
      expect(await processRossko(job, h.t.deps)).toEqual({
        outcome: 'skipped',
        reason: 'not_sending',
      });
      expect(h.caller.count('GetCheckout')).toBe(1);
      expect((await orderOf(h.t, seeded.orderId)).status).toBe('ordered_at_supplier');
      expect(
        (await eventsOf(h.t, seeded.orderId)).filter(
          (e) => e.type === 'supplier_checkout_succeeded',
        ),
      ).toHaveLength(1);
    });

    it('two concurrent runs: one GetCheckout, the other goes to recovery, which finds it settled', async () => {
      const h = await make();
      const seeded = await seedOrder(h.t, OK_LINES);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      const job = await jobFromOutbox(h.t, checkoutKey(attempt!.id));

      const results = await Promise.all([
        processRossko(job, h.t.deps),
        processRossko(job, h.t.deps),
      ]);
      expect(h.caller.count('GetCheckout')).toBe(1);
      expect(results.filter((r) => (r as { outcome: string }).outcome === 'created')).toHaveLength(
        1,
      );
      if (await outboxRow(h.t, `recover:${attempt!.id}`)) {
        const recover = await processRossko(
          await jobFromOutbox(h.t, `recover:${attempt!.id}`),
          h.t.deps,
        );
        expect(recover).toEqual({ outcome: 'skipped', reason: 'not_sending' });
      }
      expect(h.caller.count('GetOrders')).toBe(0);
      expect((await orderOf(h.t, seeded.orderId)).status).toBe('ordered_at_supplier');
    });
  });

  describe('recovery after a timeout (decision Б14)', () => {
    it('timeout → recovery queued; the job again never calls GetCheckout; found by comment', async () => {
      const h = await make({ checkoutVariant: 'timeout' });
      const seeded = await seedOrder(h.t, OK_LINES);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);

      expect(await runCheckout(h.t, attempt!.id)).toEqual({
        outcome: 'recover_queued',
        reason: 'ambiguous_error',
      });
      const [sending] = await supplierOrdersOf(h.t, seeded.orderId);
      expect(sending).toMatchObject({ status: 'sending', calledAt: T0 });
      expect(sending?.error).toMatch(/timeout/);
      const queued = await outboxRow(h.t, `recover:${attempt!.id}`);
      expect(queued).toMatchObject({ queue: 'rossko', name: 'recover' });
      // Long enough for a stalled run still waiting for the limiter (60 s) and its timeout.
      expect(queued!.availableAt.getTime()).toBe(T0.getTime() + recoverDelayMs(h.t.deps.env));
      expect(recoverDelayMs(h.t.deps.env)).toBeGreaterThanOrEqual(
        60_000 + h.t.deps.env.ROSSKO_TIMEOUT_MS,
      );
      expect((await orderOf(h.t, seeded.orderId)).status).toBe('ordering');

      // called_at is set: a repeated checkout job goes to recovery, GetCheckout stays at 1.
      expect(await runCheckout(h.t, attempt!.id)).toEqual({
        outcome: 'recover_queued',
        reason: 'called_before',
      });
      expect(h.caller.count('GetCheckout')).toBe(1);

      const recovered = await processRossko(
        await jobFromOutbox(h.t, `recover:${attempt!.id}`, { attempts: 3 }),
        h.t.deps,
      );
      expect(recovered).toMatchObject({ outcome: 'created', itemErrors: 0 });
      expect(h.caller.count('GetCheckout')).toBe(1);
      expect(h.caller.count('GetOrders')).toBe(1);
      const [row] = await supplierOrdersOf(h.t, seeded.orderId);
      expect(row).toMatchObject({ status: 'created', rosskoOrderIds: ['79000001'] });
      expect(row?.recoveredAt).toEqual(T0);
      expect(row?.response).toMatchObject({ source: 'recover' });
      expect((await orderOf(h.t, seeded.orderId)).status).toBe('ordered_at_supplier');
      expect((await itemsOf(h.t, seeded.orderId)).map((i) => i.state)).toEqual([
        'ordered',
        'ordered',
      ]);
      expect(h.t.fakes.alerts.calls).toEqual([]);
    });

    it('called_at already set (crash after the claim), order found by comment: no GetCheckout at all', async () => {
      const h = await make({ checkoutVariant: 'timeout' });
      const seeded = await seedOrder(h.t, OK_LINES);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      // Rossko executed the order of a run that died right after GetCheckout left.
      await h.client
        .checkout({
          comment: `${seeded.number}/1`,
          items: OK_LINES.map((line) => ({
            brand: line.brand,
            article: line.article === 'OC90' ? 'OC 90' : line.article,
            stockId: line.stockId,
            count: line.qty,
          })),
        })
        .catch(() => undefined);
      const callsBefore = h.caller.count('GetCheckout');
      await h.t.deps.db
        .update(supplierOrders)
        .set({ calledAt: T0 })
        .where(eq(supplierOrders.id, attempt!.id));

      expect(await runCheckout(h.t, attempt!.id)).toEqual({
        outcome: 'recover_queued',
        reason: 'called_before',
      });
      expect(h.caller.count('GetCheckout')).toBe(callsBefore);
      const recovered = await processRossko(
        await jobFromOutbox(h.t, `recover:${attempt!.id}`),
        h.t.deps,
      );
      expect(recovered).toMatchObject({ outcome: 'created' });
      expect(h.caller.count('GetCheckout')).toBe(callsBefore);
      expect((await orderOf(h.t, seeded.orderId)).status).toBe('ordered_at_supplier');
    });

    it.each(['recent', 'unsupported'] as const)(
      'not found (%s list) → unknown_after_timeout and an alert',
      async (ordersList) => {
        const h = await make({ checkoutVariant: 'timeoutNotExecuted', ordersList });
        const seeded = await seedOrder(h.t, OK_LINES);
        await runRecheck(h.t, seeded.orderId);
        const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
        await runCheckout(h.t, attempt!.id);

        const result = await processRossko(
          await jobFromOutbox(h.t, `recover:${attempt!.id}`, { attempts: 3 }),
          h.t.deps,
        );
        expect(result).toMatchObject({ outcome: 'failed', reason: 'unknown_after_timeout' });
        expect(h.caller.count('GetCheckout')).toBe(1);
        const [row] = await supplierOrdersOf(h.t, seeded.orderId);
        expect(row).toMatchObject({ status: 'failed' });
        expect(row?.recoveredAt).toEqual(T0);
        expect(row?.error).toBe(
          ordersList === 'unsupported' ? 'orders_list_unsupported' : 'not_found_by_comment',
        );
        const order = await orderOf(h.t, seeded.orderId);
        expect(order).toMatchObject({
          status: 'needs_attention',
          attentionReason: 'unknown_after_timeout',
        });
        expect(h.t.fakes.alerts.calls).toEqual([
          expect.objectContaining({
            audience: 'sellers',
            dedupeKey: `rossko-unknown:${attempt!.id}`,
            text: expect.stringContaining('Проверьте ЛК Rossko: заказ мог создаться'),
          }),
        ]);
        expect(h.t.fakes.alerts.calls[0]?.text).toContain(seeded.number);
        expect(h.t.fakes.alerts.calls[0]?.text).not.toContain(seeded.phone.slice(2));
        // The order is not ordered again automatically.
        expect(await outboxRow(h.t, `checkout:${attempt!.id}`)).not.toBeNull();
        expect(
          (await supplierOrdersOf(h.t, seeded.orderId)).filter((r) => r.status === 'sending'),
        ).toEqual([]);
      },
    );

    it('a transient GetOrders error is retried, then read as unknown on the last attempt', async () => {
      const h = await make({ checkoutVariant: 'timeoutNotExecuted' });
      const seeded = await seedOrder(h.t, OK_LINES);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      await runCheckout(h.t, attempt!.id);
      h.t.deps.rossko = {
        ...h.client,
        recentOrders: async () => {
          throw new RosskoCallError('GetOrders', 'timeout of 15000ms exceeded', { timeout: true });
        },
      };
      const key = `recover:${attempt!.id}`;
      await expect(
        processRossko(await jobFromOutbox(h.t, key, { attemptsMade: 0, attempts: 3 }), h.t.deps),
      ).rejects.toBeInstanceOf(RosskoCallError);
      expect((await supplierOrdersOf(h.t, seeded.orderId))[0]?.status).toBe('sending');
      expect(
        await processRossko(
          await jobFromOutbox(h.t, key, { attemptsMade: 2, attempts: 3 }),
          h.t.deps,
        ),
      ).toMatchObject({ outcome: 'failed', reason: 'unknown_after_timeout' });
    });
  });

  describe('other outcomes', () => {
    it('lines Rossko does not mention are item errors `unmatched` (never re-ordered blindly)', async () => {
      const h = await make();
      // GetCheckout.ok covers Knecht OC 90 x2 and TRW GDB1330 x1; W 914/2 is not in it.
      const seeded = await seedOrder(h.t, [
        OK_LINES[0]!,
        OK_LINES[1]!,
        { article: 'W9142', brand: 'MANN-FILTER', stockId: 'MSK7', qty: 1 },
      ]);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      expect(await runCheckout(h.t, attempt!.id)).toMatchObject({
        outcome: 'created',
        itemErrors: 1,
      });
      const items = await itemsOf(h.t, seeded.orderId);
      expect(items.map((i) => i.state)).toEqual(['ordered', 'ordered', 'pending']);
      expect(items[2]?.supplierItemError).toEqual(UNMATCHED_ITEM_ERROR);
      expect((await orderOf(h.t, seeded.orderId)).attentionReason).toBe('item_errors');
    });

    it('an order cancelled before the call: the attempt fails without GetCheckout', async () => {
      const h = await make();
      const seeded = await seedOrder(h.t, OK_LINES);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      await h.t.deps.db
        .update(orders)
        .set({ status: 'refund_pending' })
        .where(eq(orders.id, seeded.orderId));
      expect(await runCheckout(h.t, attempt!.id)).toEqual({
        outcome: 'cancelled',
        status: 'refund_pending',
      });
      expect(h.caller.count('GetCheckout')).toBe(0);
      const [row] = await supplierOrdersOf(h.t, seeded.orderId);
      expect(row).toMatchObject({ status: 'failed', error: 'order_status:refund_pending' });
    });

    it('an order cancelled while GetCheckout is in flight: alert with the Russian status', async () => {
      const h = await make();
      const seeded = await seedOrder(h.t, OK_LINES);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      h.t.deps.rossko = {
        ...h.client,
        checkout: async (request) => {
          const result = await h.client.checkout(request);
          await h.t.deps.db
            .update(orders)
            .set({ status: 'cancelled' })
            .where(eq(orders.id, seeded.orderId));
          return result;
        },
      };
      const result = await runCheckout(h.t, attempt!.id);
      expect(result).toMatchObject({ outcome: 'created', transition: { ok: false } });
      expect(h.t.fakes.alerts.calls).toEqual([
        expect.objectContaining({
          audience: 'sellers',
          dedupeKey: `rossko-late:${attempt!.id}`,
          text: expect.stringContaining('заказ уже в статусе «отменён»'),
        }),
      ]);
      expect(h.t.fakes.alerts.calls[0]?.text).not.toContain('cancelled');
    });

    it('a late answer already recorded by recovery (same Rossko orders) raises no alert', async () => {
      const h = await make();
      const seeded = await seedOrder(h.t, OK_LINES);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      h.t.deps.rossko = {
        ...h.client,
        checkout: async (request) => {
          const result = await h.client.checkout(request);
          // Recovery settled the attempt while this run was still waiting for the answer.
          await h.t.deps.db
            .update(supplierOrders)
            .set({ status: 'created', rosskoOrderIds: result.orderIds })
            .where(eq(supplierOrders.id, attempt!.id));
          return result;
        },
      };
      expect(await runCheckout(h.t, attempt!.id)).toEqual({
        outcome: 'stale',
        supplierOrderId: attempt!.id,
      });
      expect(h.caller.count('GetCheckout')).toBe(1);
      expect(h.t.fakes.alerts.calls).toEqual([]);
    });

    it('a late answer after the attempt was closed as failed raises the alert', async () => {
      const h = await make();
      const seeded = await seedOrder(h.t, OK_LINES);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      h.t.deps.rossko = {
        ...h.client,
        checkout: async (request) => {
          const result = await h.client.checkout(request);
          await h.t.deps.db
            .update(supplierOrders)
            .set({ status: 'failed', error: 'not_found_by_comment' })
            .where(eq(supplierOrders.id, attempt!.id));
          return result;
        },
      };
      expect(await runCheckout(h.t, attempt!.id)).toMatchObject({ outcome: 'stale' });
      expect(h.t.fakes.alerts.calls).toEqual([
        expect.objectContaining({
          dedupeKey: `rossko-late:${attempt!.id}`,
          text: expect.stringContaining('попытка уже закрыта как несостоявшаяся'),
        }),
      ]);
      expect(h.t.fakes.alerts.calls[0]?.text).toContain(seeded.number);
      expect(h.t.fakes.alerts.calls[0]?.text).not.toContain(seeded.phone.slice(2));
    });

    it('missing ids before the call (RosskoConfigError) → checkout_failed', async () => {
      const h = await make({ env: { ROSSKO_PAYMENT_ID: '' } });
      const seeded = await seedOrder(h.t, OK_LINES);
      await runRecheck(h.t, seeded.orderId);
      const [attempt] = await supplierOrdersOf(h.t, seeded.orderId);
      expect(await runCheckout(h.t, attempt!.id)).toMatchObject({
        outcome: 'failed',
        reason: 'checkout_failed',
      });
      expect(h.caller.count('GetCheckout')).toBe(0);
      expect(await outboxRow(h.t, `recover:${attempt!.id}`)).toBeNull();
      expect((await orderOf(h.t, seeded.orderId)).attentionReason).toBe('checkout_failed');
    });

    it('bad job data and unknown job names are not retried', async () => {
      const h = await make();
      const bad = { name: 'checkout', data: { supplierOrderId: 'nope' } } as unknown as Job;
      await expect(processRossko(bad, h.t.deps)).rejects.toBeInstanceOf(UnrecoverableError);
      const unknown = { name: 'poll-orders', data: {} } as unknown as Job;
      await expect(processRossko(unknown, h.t.deps)).rejects.toBeInstanceOf(UnrecoverableError);
      const missing = {
        name: 'checkout',
        data: { supplierOrderId: '01900000-0000-7000-8000-000000000000' },
      } as unknown as Job;
      expect(await processRossko(missing, h.t.deps)).toEqual({
        outcome: 'skipped',
        reason: 'not_found',
      });
    });
  });
});
