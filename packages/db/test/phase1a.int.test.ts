// Migration 0001_phase_1a (docs/phase-1a-implementation.md section 1): it applies over a
// database that already holds phase 0 data, and its constraints reject what they must.
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDatabaseUrl } from '@detaly/config/testing';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrateDb, MIGRATIONS_FOLDER, type Db } from '../src/client';
import { and, eq, isNull, sql } from '../src/index';
import {
  cartItems,
  carts,
  consents,
  documentVersions,
  orderEvents,
  orderItems,
  orders,
  payments,
} from '../src/schema';
import { dropDatabase, ensureDatabase } from '../src/testing';
import { expectPgError, insertOrder, insertUser, randomToken, SAMPLE_OFFER } from './helpers';

const UNIQUE = '23505';
const CHECK = '23514';
const FOREIGN_KEY = '23503';

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** A copy of the migrations folder whose journal stops after `tag`. */
async function migrationsUpTo(tag: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'detaly-mig-'));
  await cp(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
  const last = journal.entries.findIndex((entry) => entry.tag === tag);
  if (last < 0) throw new Error(`no migration ${tag}`);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

describe('0001_phase_1a over phase 0 data', () => {
  const url = (() => {
    const base = new URL(testDatabaseUrl());
    base.pathname = `${base.pathname}_p1a_${randomBytes(4).toString('hex')}`;
    return base.toString();
  })();
  let db: Db;
  let phase0Dir: string;

  beforeAll(async () => {
    await ensureDatabase(url);
    db = createDb(url, { max: 3 });
    phase0Dir = await migrationsUpTo('0000_init');
  });

  afterAll(async () => {
    await db?.close();
    await dropDatabase(url);
    if (phase0Dir) await rm(phase0Dir, { recursive: true, force: true });
  });

  it('applies on a database with users, an empty cart, an order and a consent', async () => {
    await migrateDb(db, { migrationsFolder: phase0Dir });
    const userId = uuidv7();
    const cartId = uuidv7();
    const docId = uuidv7();
    // Raw SQL: the TypeScript schema already describes the phase 1A columns.
    await db.$client`insert into users (id, phone) values (${userId}, '+79120000001')`;
    await db.$client`insert into carts (id, anon_token) values (${cartId}, ${randomToken()})`;
    await db.$client`
      insert into document_versions (id, kind, version, title, body_md, sha256, source_path)
      values (${docId}, 'consent_pd', 'p0', 't', 'b', ${'a'.repeat(64)}, 'x')`;
    await db.$client`
      insert into consents (id, user_id, document_version_id, kind, channel, text_sha256)
      values (${uuidv7()}, ${userId}, ${docId}, 'pd', 'web', ${'a'.repeat(64)})`;
    await db.$client`
      insert into orders
        (id, user_id, access_token, payment_scheme, subtotal_kop, total_kop, items_hash)
      values (${uuidv7()}, ${userId}, ${randomToken()}, 'prepay', 100, 100, 'h')`;

    await migrateDb(db);

    const [order] = await db.select().from(orders);
    expect(order).toMatchObject({ checkoutKey: null, cartId: null, preferredChannel: null });
    const [consent] = await db.select().from(consents);
    expect(consent?.orderId).toBeNull();
    const [cart] = await db.select().from(carts).where(eq(carts.id, cartId));
    expect(cart?.status).toBe('active');
  });
});

describe('phase 1A constraints', () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(testDatabaseUrl(), { max: 4 });
  });

  afterAll(async () => {
    await db?.close();
  });

  async function insertCart() {
    const [cart] = await db.insert(carts).values({ anonToken: randomToken() }).returning();
    if (!cart) throw new Error('cart not inserted');
    return cart;
  }

  const cartLine = (cartId: string, overrides: Partial<typeof cartItems.$inferInsert> = {}) => ({
    cartId,
    offerKey: 'W9142:MANN:ORB1',
    searchArticleNorm: 'W9142',
    brand: 'MANN',
    article: 'W 914/2',
    name: 'Фильтр масляный',
    qty: 1,
    stockId: 'ORB1',
    isLocal: true,
    priceSupplierKop: 100_000,
    priceClientKop: 128_000,
    markupBp: 2800,
    offerSnapshot: SAMPLE_OFFER,
    fetchedAt: new Date(),
    ...overrides,
  });

  it('keeps one line per (cart, offer_key): duplicates fail with 23505, upsert works', async () => {
    const cart = await insertCart();
    await db.insert(cartItems).values(cartLine(cart.id));
    await expectPgError(
      db.insert(cartItems).values(cartLine(cart.id)),
      UNIQUE,
      'cart_items_cart_id_offer_key_unique',
    );
    // The same offer in another cart is fine.
    const other = await insertCart();
    await db.insert(cartItems).values(cartLine(other.id));
    // Upsert by the unique pair adds quantity.
    await db
      .insert(cartItems)
      .values(cartLine(cart.id, { qty: 2 }))
      .onConflictDoUpdate({
        target: [cartItems.cartId, cartItems.offerKey],
        set: { qty: sql`${cartItems.qty} + excluded.qty` },
      });
    const [line] = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
    expect(line?.qty).toBe(3);
  });

  it('checks search_article_norm in cart_items and order_items (23514)', async () => {
    const cart = await insertCart();
    for (const bad of ['oc90', 'OC 90', '', 'A'.repeat(65), 'W914/2']) {
      await expectPgError(
        db.insert(cartItems).values(cartLine(cart.id, { offerKey: bad, searchArticleNorm: bad })),
        CHECK,
        'cart_items_search_article_norm_check',
      );
    }
    const order = await insertOrder(db);
    const item = {
      orderId: order.id,
      offerKey: 'W9142:MANN:ORB1',
      searchArticleNorm: 'w9142',
      brand: 'MANN',
      article: 'W 914/2',
      name: 'Фильтр масляный',
      qty: 1,
      stockId: 'ORB1',
      isLocal: true,
      priceSupplierAtOrderKop: 100_000,
      priceClientKop: 128_000,
      markupBp: 2800,
      offerSnapshot: SAMPLE_OFFER,
    };
    await expectPgError(
      db.insert(orderItems).values(item),
      CHECK,
      'order_items_search_article_norm_check',
    );
    await db.insert(orderItems).values({ ...item, searchArticleNorm: 'OC90' });
  });

  it('allows many orders without checkout_key but rejects a duplicate key (23505)', async () => {
    await insertOrder(db);
    await insertOrder(db);
    const key = uuidv7();
    await insertOrder(db, { checkoutKey: key, preferredChannel: 'max' });
    await expectPgError(
      insertOrder(db, { checkoutKey: key }),
      UNIQUE,
      'orders_checkout_key_unique',
    );
    await expectPgError(
      db.execute(sql`update orders set preferred_channel = 'whatsapp' where checkout_key = ${key}`),
      '22P02',
    );
  });

  it('orders.cart_id is set to null when the cart is deleted; unknown cart -> 23503', async () => {
    const cart = await insertCart();
    const order = await insertOrder(db, { cartId: cart.id });
    await db.delete(carts).where(eq(carts.id, cart.id));
    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(after?.cartId).toBeNull();
    await expectPgError(
      insertOrder(db, { cartId: uuidv7() }),
      FOREIGN_KEY,
      'orders_cart_id_carts_id_fk',
    );
  });

  it('consents.order_id must reference an order (23503)', async () => {
    const user = await insertUser(db);
    const [doc] = await db
      .select({ id: documentVersions.id, sha256: documentVersions.sha256 })
      .from(documentVersions)
      .where(eq(documentVersions.kind, 'consent_pd'))
      .limit(1);
    if (!doc) throw new Error('seeded consent_pd document missing');
    const consent = {
      userId: user.id,
      documentVersionId: doc.id,
      kind: 'pd' as const,
      channel: 'web' as const,
      textSha256: doc.sha256,
    };
    await expectPgError(
      db.insert(consents).values({ ...consent, orderId: uuidv7() }),
      FOREIGN_KEY,
      'consents_order_id_orders_id_fk',
    );
    const order = await insertOrder(db, { userId: user.id });
    await db.insert(consents).values({ ...consent, orderId: order.id, ip: '203.0.113.7' });
    await db.insert(consents).values(consent);
    const rows = await db
      .select()
      .from(consents)
      .where(and(eq(consents.userId, user.id), isNull(consents.orderId)));
    expect(rows).toHaveLength(1);
  });

  it('relations load an order with user, items, events, payments, consents and offer', async () => {
    const user = await insertUser(db);
    const [offer] = await db
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(eq(documentVersions.kind, 'offer'))
      .limit(1);
    if (!offer) throw new Error('seeded offer document missing');
    const order = await insertOrder(db, { userId: user.id, offerVersionId: offer.id });
    await db.insert(orderItems).values({
      orderId: order.id,
      offerKey: 'W9142:MANN:ORB1',
      searchArticleNorm: 'W9142',
      brand: 'MANN',
      article: 'W 914/2',
      name: 'Фильтр масляный',
      qty: 1,
      stockId: 'ORB1',
      isLocal: true,
      priceSupplierAtOrderKop: 100_000,
      priceClientKop: 128_000,
      markupBp: 2800,
      offerSnapshot: SAMPLE_OFFER,
    });
    await db.insert(orderEvents).values({
      orderId: order.id,
      type: 'checkout',
      fromStatus: 'draft',
      toStatus: 'awaiting_payment',
      actorType: 'client',
    });
    await db.insert(payments).values({
      orderId: order.id,
      kind: 'prepayment',
      amountKop: 128_000,
      idempotenceKey: randomToken(),
    });

    const loaded = await db.query.orders.findFirst({
      where: (t, ops) => ops.eq(t.id, order.id),
      with: {
        user: { columns: { phone: true } },
        items: true,
        events: true,
        payments: { columns: { status: true } },
        consents: true,
        offerVersion: { columns: { kind: true } },
      },
    });
    expect(loaded?.user.phone).toBe(user.phone);
    expect(loaded?.items).toHaveLength(1);
    expect(loaded?.items[0]?.offerKey).toBe('W9142:MANN:ORB1');
    expect(loaded?.events.map((e) => e.type)).toEqual(['checkout']);
    expect(loaded?.payments).toEqual([{ status: 'pending' }]);
    expect(loaded?.consents).toEqual([]);
    expect(loaded?.offerVersion).toEqual({ kind: 'offer' });

    const cart = await insertCart();
    await db.insert(cartItems).values(cartLine(cart.id));
    const withItems = await db.query.carts.findFirst({
      where: (t, ops) => ops.eq(t.id, cart.id),
      with: { items: { columns: { offerKey: true, qty: true } } },
    });
    expect(withItems?.items).toEqual([{ offerKey: 'W9142:MANN:ORB1', qty: 1 }]);
  });
});
