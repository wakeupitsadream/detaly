// Step 6 (docs/garage.md): «Купить снова» — a repeat proposal from an order's items on the project
// database (`_vin`) with the Rossko fixtures: today's offers and prices by the VIN preview rule
// (priceOffer), marked goods and parts the supplier lacks left out with a note, the client's own
// order only, a second press returns the same live proposal, /p and the copy into the client's
// cart carry the repeated order.
import { randomBytes } from 'node:crypto';
import { cartItems, carts, createDb, eq, orderItems, orders, users, type Db } from '@detaly/db';
import {
  basePricingConfig,
  DEFAULT_EXCLUDED_RULES,
  PROPOSAL_TTL_DAYS,
  type EtaSettings,
  type MarkupRule,
  type Offer,
  type OrderItemState,
  type OrderStatus,
} from '@detaly/domain';
import {
  createFixtureCaller,
  createRosskoClient,
  createUnlimitedLimiter,
  type RosskoClient,
} from '@detaly/rossko';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  copyProposalToCart,
  createRepeatProposal,
  loadProposal,
  previewVinAnswer,
  repeatSkippedNote,
  type RepeatProposalInput,
} from '../src';

const DB_URL = inject('vinDatabaseUrl');

const RULES: MarkupRule[] = [{ fromKop: 0, toKop: null, localBp: 2800, orderBp: 2800 }];
const ETA: EtaSettings = { bufferDays: 1, invoiceLagDays: 0, prepayInvoice: false };
const T0 = new Date('2026-10-05T07:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function rosskoWith(priceFactorBp = 10_000): RosskoClient {
  return createRosskoClient({
    caller: createFixtureCaller({ priceFactorBp }),
    key1: 'k1',
    key2: 'k2',
    localStockIds: ['ORB1'],
    limiter: createUnlimitedLimiter(),
    allowCheckout: false,
  });
}

function randomPhone(): string {
  return `+79${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

interface Item {
  brand: string;
  article: string;
  articleNorm: string;
  qty?: number;
  state?: OrderItemState;
}

function snapshot(item: Item): Offer {
  return {
    source: 'rossko',
    brand: item.brand,
    article: item.article,
    articleNorm: item.articleNorm,
    name: 'Деталь из заказа',
    group: null,
    isCross: false,
    priceSupplierKop: 100,
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

describe.skipIf(!DB_URL)('«Купить снова» (repeat proposals)', () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(DB_URL as string, { max: 4 });
  });

  afterAll(async () => {
    await db?.close();
  });

  async function seedOrder(
    items: Item[],
    status: OrderStatus = 'completed',
  ): Promise<{ orderId: string; userId: string; number: string }> {
    const [user] = await db.insert(users).values({ phone: randomPhone() }).returning();
    const [order] = await db
      .insert(orders)
      .values({
        userId: user!.id,
        accessToken: randomBytes(32).toString('base64url'),
        status,
        paymentScheme: 'prepay',
        subtotalKop: 1000,
        totalKop: 1000,
        itemsHash: 'test',
      })
      .returning();
    await db.insert(orderItems).values(
      items.map((item) => ({
        orderId: order!.id,
        offerKey: `${item.articleNorm}:${item.brand}:ORB1`,
        searchArticleNorm: item.articleNorm,
        brand: item.brand,
        article: item.article,
        name: 'Деталь из заказа',
        qty: item.qty ?? 1,
        stockId: 'ORB1',
        isLocal: true,
        // An old price: the repeat must not take it.
        priceSupplierAtOrderKop: 100,
        priceClientKop: 1,
        markupBp: 0,
        offerSnapshot: snapshot(item),
        state: item.state ?? 'handed',
      })),
    );
    return { orderId: order!.id, userId: user!.id, number: order!.number };
  }

  function input(
    order: { orderId: string; userId: string },
    over: Partial<RepeatProposalInput> & { rossko?: RosskoClient } = {},
  ): RepeatProposalInput {
    const rossko = over.rossko ?? rosskoWith();
    return {
      orderId: order.orderId,
      userId: order.userId,
      search: async (article) => (await rossko.search(article)).offers,
      pricing: basePricingConfig(RULES),
      excludedRules: DEFAULT_EXCLUDED_RULES,
      eta: ETA,
      now: T0,
      ...over,
    };
  }

  const KNECHT: Item = { brand: 'Knecht', article: 'OC 90', articleNorm: 'OC90' };
  const TRW: Item = { brand: 'TRW', article: 'GDB1330', articleNorm: 'GDB1330' };
  const OIL: Item = { brand: 'CASTROL', article: 'EDGE 5W-40', articleNorm: 'EDGE5W40' };
  const GONE: Item = { brand: 'ACME', article: 'NOTFOUND', articleNorm: 'NOTFOUND' };

  it('today’s offers and prices (the VIN preview rule), lines it cannot sell left out with a note', async () => {
    const order = await seedOrder([
      { ...KNECHT, qty: 1 },
      TRW,
      OIL,
      GONE,
      { ...KNECHT, qty: 1 },
      // Out of the order: not repeated.
      { brand: 'MANN-FILTER', article: 'W 914/2', articleNorm: 'W9142', state: 'refunded' },
    ]);
    const result = await createRepeatProposal(db, input(order));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The same rule and prices as a master's answer «Knecht OC90 2 / TRW GDB1330 1».
    const rossko = rosskoWith();
    const preview = await previewVinAnswer({
      text: 'Knecht OC90 2\nTRW GDB1330 1',
      search: async (article) => (await rossko.search(article)).offers,
      pricing: basePricingConfig(RULES),
      excludedRules: DEFAULT_EXCLUDED_RULES,
      eta: ETA,
      now: T0,
    });
    const expected = preview.lines.map((line) => {
      if (line.status !== 'ok') throw new Error('preview line expected ok');
      return {
        brand: line.brand,
        article: line.article,
        qty: line.qty,
        priceClientKop: line.priceClientKop,
        etaDate: line.etaDate,
      };
    });
    expect(
      result.lines.map(({ brand, article, qty, priceClientKop, etaDate }) => ({
        brand,
        article,
        qty,
        priceClientKop,
        etaDate,
      })),
    ).toEqual(expected);
    expect(result.lines.every((line) => line.priceClientKop > 1)).toBe(true);
    expect(result.skipped).toEqual([
      { brand: 'CASTROL', article: 'EDGE 5W-40', reason: 'excluded' },
      { brand: 'ACME', article: 'NOTFOUND', reason: 'not_found' },
    ]);
    expect(result).toMatchObject({ orderNumber: order.number, duplicate: false });
    expect(result.expiresAt.getTime()).toBe(T0.getTime() + PROPOSAL_TTL_DAYS * DAY_MS);
    expect(result.totalKop).toBe(
      result.lines.reduce((sum, line) => sum + line.priceClientKop * line.qty, 0),
    );

    // The proposal cart: no VIN request, the repeated order, the note; /p shows it.
    const [cart] = await db.select().from(carts).where(eq(carts.id, result.cartId));
    expect(cart).toMatchObject({
      status: 'active',
      vinRequestId: null,
      repeatOrderId: order.orderId,
      sellerNote: repeatSkippedNote(result.skipped),
    });
    expect(cart?.sellerNote).toBe(
      'Не вошли: CASTROL EDGE 5W-40 — не продаём онлайн; ACME NOTFOUND — нет у поставщика',
    );
    const proposal = await loadProposal(db, result.token, T0);
    expect(proposal).toMatchObject({
      vinRequestId: null,
      expired: false,
      repeat: { orderId: order.orderId, orderNumber: order.number },
    });
    expect(proposal?.lines).toHaveLength(2);
  });

  it('prices follow the supplier: a later press with dearer offers gives the new prices', async () => {
    const order = await seedOrder([TRW]);
    const before = await createRepeatProposal(db, input(order));
    const after = await createRepeatProposal(
      db,
      input(order, { rossko: rosskoWith(11_000), now: new Date(T0.getTime() + 60_000) }),
    );
    if (!before.ok || !after.ok) throw new Error('proposals expected');
    expect(after.lines[0]!.priceClientKop).toBeGreaterThan(before.lines[0]!.priceClientKop);
    expect(after.token).not.toBe(before.token);
    expect(after.duplicate).toBe(false);
  });

  it('a second press with the same result returns the live proposal', async () => {
    const order = await seedOrder([KNECHT, TRW]);
    const first = await createRepeatProposal(db, input(order));
    const second = await createRepeatProposal(
      db,
      input(order, { now: new Date(T0.getTime() + 5000) }),
    );
    if (!first.ok || !second.ok) throw new Error('proposals expected');
    expect(second).toMatchObject({ duplicate: true, token: first.token, cartId: first.cartId });
    expect(
      await db.select().from(carts).where(eq(carts.repeatOrderId, order.orderId)),
    ).toHaveLength(1);
    // Past its date the next press makes a fresh one.
    const later = await createRepeatProposal(
      db,
      input(order, { now: new Date(T0.getTime() + (PROPOSAL_TTL_DAYS + 1) * DAY_MS) }),
    );
    expect(later.ok && later.duplicate).toBe(false);
  });

  it('only the client’s own order, never a draft; nothing to offer is said so', async () => {
    const order = await seedOrder([KNECHT]);
    const stranger = await seedOrder([KNECHT]);
    expect(
      await createRepeatProposal(db, input({ orderId: order.orderId, userId: stranger.userId })),
    ).toEqual({ ok: false, reason: 'not_found', orderNumber: null, skipped: [] });
    expect(
      await createRepeatProposal(db, input({ orderId: 'nope', userId: order.userId })),
    ).toMatchObject({ ok: false, reason: 'not_found' });
    const draft = await seedOrder([KNECHT], 'draft');
    expect(await createRepeatProposal(db, input(draft))).toMatchObject({
      ok: false,
      reason: 'not_found',
    });

    const nothing = await seedOrder([OIL, GONE]);
    expect(await createRepeatProposal(db, input(nothing))).toEqual({
      ok: false,
      reason: 'none_available',
      orderNumber: nothing.number,
      skipped: [
        { brand: 'CASTROL', article: 'EDGE 5W-40', reason: 'excluded' },
        { brand: 'ACME', article: 'NOTFOUND', reason: 'not_found' },
      ],
    });
    const dropped = await seedOrder([{ ...KNECHT, state: 'refunded' }]);
    expect(await createRepeatProposal(db, input(dropped))).toMatchObject({
      ok: false,
      reason: 'empty',
    });
    const down = await seedOrder([KNECHT]);
    expect(
      await createRepeatProposal(
        db,
        input(down, {
          search: async () => {
            throw new Error('quota');
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      reason: 'supplier_unavailable',
      skipped: [{ brand: 'Knecht', article: 'OC 90', reason: 'supplier' }],
    });
    expect(await db.select().from(carts).where(eq(carts.repeatOrderId, nothing.orderId))).toEqual(
      [],
    );
  });

  it('«Оформить» copies the lines and the repeated order into the client’s cart', async () => {
    const order = await seedOrder([KNECHT]);
    const result = await createRepeatProposal(db, input(order));
    if (!result.ok) throw new Error('proposal expected');
    const [target] = await db
      .insert(carts)
      .values({ anonToken: randomBytes(32).toString('base64url'), status: 'active' })
      .returning();
    const copied = await db.transaction((tx) =>
      copyProposalToCart(tx, { proposalCartId: result.cartId, targetCartId: target!.id, now: T0 }),
    );
    expect(copied).toMatchObject({ ok: true, inserted: 1, vinRequestId: null });
    const [after] = await db.select().from(carts).where(eq(carts.id, target!.id));
    expect(after).toMatchObject({ repeatOrderId: order.orderId, vinRequestId: null });
    const lines = await db.select().from(cartItems).where(eq(cartItems.cartId, target!.id));
    expect(lines.map((line) => line.priceClientKop)).toEqual([result.lines[0]!.priceClientKop]);
  });
});
