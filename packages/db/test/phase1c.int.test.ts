// Migration 0004_phase_1c (docs/phase-1c-implementation.md section 1): it applies over a
// database that already holds phase 1B data, and its constraints reject what they must.
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testDatabaseUrl } from '@detaly/config/testing';
import { claimDeadline, FILE_KEY_PATTERN, SELLER_CARD_KINDS } from '@detaly/domain';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrateDb, MIGRATIONS_FOLDER, type Db } from '../src/client';
import { eq } from '../src/index';
import {
  carts,
  claims,
  consents,
  documentVersions,
  installBookings,
  linkTokens,
  notifications,
  orderItems,
  orderPhotos,
  orders,
  sellerCards,
  vinRequests,
} from '../src/schema';
import { dropDatabase, ensureDatabase } from '../src/testing';
import { expectPgError, insertOrder, insertUser, randomToken, SAMPLE_OFFER } from './helpers';

const UNIQUE = '23505';
const CHECK = '23514';

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

const fileKey = (scope: 'vin' | 'claim' | 'order', ownerId: string) =>
  `${scope}/${ownerId}/${uuidv7()}.jpg`;

describe('0004_phase_1c over phase 1B data', () => {
  const url = (() => {
    const base = new URL(testDatabaseUrl());
    base.pathname = `${base.pathname}_p1c_${randomBytes(4).toString('hex')}`;
    return base.toString();
  })();
  let db: Db;
  let phase1bDir: string;

  beforeAll(async () => {
    await ensureDatabase(url);
    db = createDb(url, { max: 3 });
    phase1bDir = await migrationsUpTo('0003_refund_retry');
  });

  afterAll(async () => {
    await db?.close();
    await dropDatabase(url);
    if (phase1bDir) await rm(phase1bDir, { recursive: true, force: true });
  });

  it('applies on a database with a handed 1B order, its seller card, link token and cart', async () => {
    await migrateDb(db, { migrationsFolder: phase1bDir });
    const userId = uuidv7();
    const orderId = uuidv7();
    const cartId = uuidv7();
    // Raw SQL: the TypeScript schema already describes the phase 1C columns.
    await db.$client`insert into users (id, phone) values (${userId}, '+79120000003')`;
    await db.$client`insert into carts (id, anon_token) values (${cartId}, ${randomToken()})`;
    await db.$client`
      insert into orders
        (id, user_id, access_token, payment_scheme, subtotal_kop, total_kop, items_hash,
         status, checkout_key, handed_at, cart_id)
      values (${orderId}, ${userId}, ${randomToken()}, 'prepay', 128000, 128000, 'h',
              'handed', ${uuidv7()}, now(), ${cartId})`;
    await db.$client`
      insert into seller_cards (id, order_id, chat_id, nonce, kind)
      values (${uuidv7()}, ${orderId}, '-100123', ${randomBytes(6).toString('base64url')}, 'qr')`;
    await db.$client`
      insert into link_tokens (token, user_id, order_id, expires_at)
      values (${randomToken()}, ${userId}, ${orderId}, now() + interval '1 day')`;
    await db.$client`
      insert into notifications (id, chat_id, order_id, template, dedupe_key)
      values (${uuidv7()}, '-100123', ${orderId}, 'staff_new_order', ${randomUUID()})`;

    await migrateDb(db);

    const [token] = await db.select().from(linkTokens);
    expect(token).toMatchObject({ channel: 'telegram', usedByExternalId: null });
    const [card] = await db.select().from(sellerCards);
    expect(card).toMatchObject({ orderId, vinRequestId: null, kind: 'qr' });
    const [order] = await db.select().from(orders);
    expect(order?.vinRequestId).toBeNull();
    const [cart] = await db.select().from(carts);
    expect(cart?.proposalExpiresAt).toBeNull();
    const [notification] = await db.select().from(notifications);
    expect(notification?.vinRequestId).toBeNull();
  });
});

describe('phase 1C constraints', () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(testDatabaseUrl(), { max: 4 });
  });

  afterAll(async () => {
    await db?.close();
  });

  async function insertItem(orderId: string) {
    const [item] = await db
      .insert(orderItems)
      .values({
        orderId,
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
      })
      .returning();
    if (!item) throw new Error('item not inserted');
    return item;
  }

  function claimRow(orderId: string, extra: Partial<typeof claims.$inferInsert> = {}) {
    const openedAt = new Date();
    return {
      orderId,
      kind: 'defect' as const,
      openedAt,
      deadlineAt: claimDeadline(openedAt),
      openedVia: 'web',
      ...extra,
    };
  }

  async function insertVinRequest(extra: Partial<typeof vinRequests.$inferInsert> = {}) {
    const [row] = await db
      .insert(vinRequests)
      .values({ phone: '+79120000004', needText: 'Колодки передние', ...extra })
      .returning();
    if (!row) throw new Error('vin request not inserted');
    return row;
  }

  describe('claims', () => {
    it('one open claim per item and per whole order; closed or other targets are free', async () => {
      const order = await insertOrder(db, { status: 'handed' });
      const itemA = await insertItem(order.id);
      const itemB = await insertItem(order.id);

      const [first] = await db
        .insert(claims)
        .values(claimRow(order.id, { orderItemId: itemA.id }))
        .returning();
      await expectPgError(
        db.insert(claims).values(claimRow(order.id, { orderItemId: itemA.id })),
        UNIQUE,
        'claims_open_target_unique',
      );
      // another item and the whole order are other targets
      await db.insert(claims).values(claimRow(order.id, { orderItemId: itemB.id }));
      await db.insert(claims).values(claimRow(order.id));
      await expectPgError(
        db.insert(claims).values(claimRow(order.id)),
        UNIQUE,
        'claims_open_target_unique',
      );
      // after closing, the same item may be claimed again
      await db.update(claims).set({ closedAt: new Date() }).where(eq(claims.id, first!.id));
      await db.insert(claims).values(claimRow(order.id, { orderItemId: itemA.id }));
    });

    it('a repeated form submit is caught by request_key (23505)', async () => {
      const order = await insertOrder(db, { status: 'handed' });
      const requestKey = uuidv7();
      await db.insert(claims).values(claimRow(order.id, { requestKey }));
      const other = await insertOrder(db, { status: 'handed' });
      await expectPgError(
        db.insert(claims).values(claimRow(other.id, { requestKey })),
        UNIQUE,
        'claims_request_key_unique',
      );
    });

    it('deadline_at is exactly opened_at + 10 days (23514)', async () => {
      const order = await insertOrder(db, { status: 'handed' });
      const openedAt = new Date('2026-10-02T10:00:00Z');
      await expectPgError(
        db.insert(claims).values(
          claimRow(order.id, {
            openedAt,
            deadlineAt: new Date(openedAt.getTime() + 9 * 86_400_000),
          }),
        ),
        CHECK,
        'claims_deadline_check',
      );
      await expectPgError(
        db.insert(claims).values(
          claimRow(order.id, {
            openedAt,
            deadlineAt: new Date(claimDeadline(openedAt).getTime() + 1),
          }),
        ),
        CHECK,
        'claims_deadline_check',
      );
      await db
        .insert(claims)
        .values(claimRow(order.id, { openedAt, deadlineAt: claimDeadline(openedAt) }));
    });

    it('a decision needs decided_at and an answer of 1..2000 characters (23514)', async () => {
      const order = await insertOrder(db, { status: 'handed' });
      const [claim] = await db.insert(claims).values(claimRow(order.id)).returning();
      const decide = (set: Partial<typeof claims.$inferInsert>) =>
        db.update(claims).set(set).where(eq(claims.id, claim!.id));
      await expectPgError(
        decide({ decision: 'reject', decidedAt: new Date() }),
        CHECK,
        'claims_decision_text_check',
      );
      await expectPgError(
        decide({ decision: 'reject', decidedAt: new Date(), decisionText: '   ' }),
        CHECK,
        'claims_decision_text_check',
      );
      await expectPgError(
        decide({ decision: 'reject', decisionText: 'Нет оснований' }),
        CHECK,
        'claims_decision_text_check',
      );
      await expectPgError(
        decide({ decision: 'reject', decidedAt: new Date(), decisionText: 'я'.repeat(2001) }),
        CHECK,
        'claims_decision_text_check',
      );
      await decide({
        decision: 'reject',
        decidedAt: new Date(),
        decidedVia: 'admin',
        decisionText: 'я'.repeat(2000),
      });
    });

    it('an override reason only with a refund decision; via and text limits (23514)', async () => {
      const order = await insertOrder(db, { status: 'handed' });
      await expectPgError(
        db.insert(claims).values(claimRow(order.id, { overrideReason: 'видео брака' })),
        CHECK,
        'claims_override_reason_check',
      );
      await expectPgError(
        db.insert(claims).values(
          claimRow(order.id, {
            decision: 'reject',
            decidedAt: new Date(),
            decisionText: 'Отказ',
            overrideReason: 'видео брака',
          }),
        ),
        CHECK,
        'claims_override_reason_check',
      );
      await expectPgError(
        db.insert(claims).values(claimRow(order.id, { openedVia: 'sms' })),
        CHECK,
        'claims_opened_via_check',
      );
      await expectPgError(
        db.insert(claims).values(claimRow(order.id, { decidedVia: 'web' })),
        CHECK,
        'claims_decided_via_check',
      );
      await expectPgError(
        db.insert(claims).values(claimRow(order.id, { clientText: 'а'.repeat(1001) })),
        CHECK,
        'claims_client_text_check',
      );
      await expectPgError(
        db
          .insert(claims)
          .values(
            claimRow(order.id, { photos: [1, 2, 3, 4].map(() => fileKey('claim', order.id)) }),
          ),
        CHECK,
        'claims_photos_check',
      );
      await db.insert(claims).values(
        claimRow(order.id, {
          decision: 'refund',
          decidedAt: new Date(),
          decisionText: 'Возвращаем деньги',
          overrideReason: 'Клиент прислал видео брака',
          clientText: 'а'.repeat(1000),
          photos: [1, 2, 3].map(() => fileKey('claim', order.id)),
        }),
      );
    });
  });

  describe('install_bookings', () => {
    it('one active booking per order; cancelled ones do not count (23505)', async () => {
      const order = await insertOrder(db, { status: 'ready' });
      const booking = (extra: Partial<typeof installBookings.$inferInsert> = {}) => ({
        orderId: order.id,
        userId: order.userId,
        slotAt: new Date('2026-10-08T09:00:00Z'),
        createdVia: 'web',
        ...extra,
      });
      const [first] = await db.insert(installBookings).values(booking()).returning();
      await expectPgError(
        db.insert(installBookings).values(booking({ status: 'confirmed' })),
        UNIQUE,
        'install_bookings_order_active_unique',
      );
      await db
        .update(installBookings)
        .set({ status: 'cancelled', cancelledAt: new Date() })
        .where(eq(installBookings.id, first!.id));
      const requestKey = uuidv7();
      await db.insert(installBookings).values(booking({ requestKey }));
      await db.insert(installBookings).values(booking({ status: 'done' }));
      await expectPgError(
        db.insert(installBookings).values(booking({ status: 'no_show', requestKey })),
        UNIQUE,
        'install_bookings_request_key_unique',
      );
      await expectPgError(
        db.insert(installBookings).values(booking({ status: 'done', createdVia: 'phone' })),
        CHECK,
        'install_bookings_created_via_check',
      );
    });

    it('has no money columns (installation is paid at the service)', async () => {
      const columns = await db.$client<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'install_bookings'`;
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.filter((c) => /_kop$|price|amount|fee/.test(c.column_name))).toEqual([]);
    });
  });

  describe('order_photos', () => {
    it('a return photo needs its claim; keys follow the FileStore mask (23514)', async () => {
      const order = await insertOrder(db, { status: 'handed' });
      const [claim] = await db.insert(claims).values(claimRow(order.id)).returning();
      await expectPgError(
        db
          .insert(orderPhotos)
          .values({ orderId: order.id, kind: 'return', s3Key: fileKey('order', order.id) }),
        CHECK,
        'order_photos_return_claim_check',
      );
      await db.insert(orderPhotos).values({
        orderId: order.id,
        kind: 'return',
        claimId: claim!.id,
        s3Key: fileKey('order', order.id),
      });
      await db
        .insert(orderPhotos)
        .values({ orderId: order.id, kind: 'packaging', s3Key: fileKey('order', order.id) });
      for (const bad of [
        '../etc/passwd',
        `order/${order.id}/../../etc.jpg`,
        `order/${order.id}/${uuidv7()}.png`,
        `files/${order.id}/${uuidv7()}.jpg`,
        `order/${order.id.toUpperCase()}/${uuidv7()}.jpg`,
        `/order/${order.id}/${uuidv7()}.jpg`,
        `order/${order.id}/${uuidv7()}.jpg\n`,
      ]) {
        await expectPgError(
          db.insert(orderPhotos).values({ orderId: order.id, kind: 'packaging', s3Key: bad }),
          CHECK,
          'order_photos_s3_key_check',
        );
        expect(new RegExp(FILE_KEY_PATTERN).test(bad)).toBe(false);
      }
    });
  });

  describe('vin_requests', () => {
    it('at most 3 photos; request_key unique; open index (23514, 23505)', async () => {
      const id = uuidv7();
      await expectPgError(
        insertVinRequest({ id, photos: [1, 2, 3, 4].map(() => fileKey('vin', id)) }),
        CHECK,
        'vin_requests_photos_check',
      );
      const requestKey = uuidv7();
      const row = await insertVinRequest({
        id,
        photos: [1, 2, 3].map(() => fileKey('vin', id)),
        channel: 'telegram',
        requestKey,
      });
      expect(row).toMatchObject({ proposalCount: 0, preview: null, closedAt: null });
      await expectPgError(
        insertVinRequest({ requestKey }),
        UNIQUE,
        'vin_requests_request_key_unique',
      );
      await expectPgError(
        insertVinRequest({ proposalCount: -1 }),
        CHECK,
        'vin_requests_proposal_count_check',
      );
    });
  });

  describe('carts, orders, consents, notifications', () => {
    it('a proposal token comes with its expiry and vice versa (23514)', async () => {
      await expectPgError(
        db.insert(carts).values({ proposalToken: randomToken() }),
        CHECK,
        'carts_proposal_expires_at_check',
      );
      await expectPgError(
        db.insert(carts).values({ anonToken: randomToken(), proposalExpiresAt: new Date() }),
        CHECK,
        'carts_proposal_expires_at_check',
      );
      const vin = await insertVinRequest();
      const [proposal] = await db
        .insert(carts)
        .values({
          proposalToken: randomToken(),
          proposalExpiresAt: new Date(Date.now() + 7 * 86_400_000),
          vinRequestId: vin.id,
        })
        .returning();
      expect(proposal?.proposalExpiresAt).toBeInstanceOf(Date);
    });

    it('orders, consents and notifications reference a VIN request', async () => {
      const vin = await insertVinRequest();
      const order = await insertOrder(db, { vinRequestId: vin.id });
      expect(order.vinRequestId).toBe(vin.id);
      const user = await insertUser(db);
      const [doc] = await db.select().from(documentVersions).limit(1);
      if (doc) {
        const [consent] = await db
          .insert(consents)
          .values({
            userId: user.id,
            documentVersionId: doc.id,
            kind: 'pd',
            channel: 'web',
            textSha256: doc.sha256,
            vinRequestId: vin.id,
          })
          .returning();
        expect(consent?.vinRequestId).toBe(vin.id);
      }
      const [notification] = await db
        .insert(notifications)
        .values({
          userId: user.id,
          vinRequestId: vin.id,
          template: 'vin_received',
          dedupeKey: `vin:${vin.id}:vin_received:0:none`,
          status: 'skipped',
        })
        .returning();
      expect(notification?.vinRequestId).toBe(vin.id);
      // a foreign key, not a free uuid
      await expectPgError(insertOrder(db, { vinRequestId: uuidv7() }), '23503');
      // deleting the request keeps the order (on delete set null)
      await db.delete(notifications).where(eq(notifications.vinRequestId, vin.id));
      await db.delete(consents).where(eq(consents.vinRequestId, vin.id));
      await db.delete(vinRequests).where(eq(vinRequests.id, vin.id));
      const [kept] = await db.select().from(orders).where(eq(orders.id, order.id));
      expect(kept?.vinRequestId).toBeNull();
    });
  });

  describe('seller_cards', () => {
    it('belong to exactly one owner; a vin card to a VIN request (23514)', async () => {
      const order = await insertOrder(db);
      const vin = await insertVinRequest();
      const nonce = () => randomBytes(6).toString('base64url');
      const card = (extra: Partial<typeof sellerCards.$inferInsert>) => ({
        chatId: '-100123',
        nonce: nonce(),
        kind: 'order',
        ...extra,
      });
      expect(SELLER_CARD_KINDS).toEqual(['order', 'qr', 'vin']);
      await expectPgError(
        db.insert(sellerCards).values(card({ orderId: order.id, vinRequestId: vin.id })),
        CHECK,
        'seller_cards_owner_check',
      );
      await expectPgError(
        db.insert(sellerCards).values(card({})),
        CHECK,
        'seller_cards_owner_check',
      );
      await expectPgError(
        db.insert(sellerCards).values(card({ vinRequestId: vin.id, kind: 'order' })),
        CHECK,
        'seller_cards_vin_owner_check',
      );
      await expectPgError(
        db.insert(sellerCards).values(card({ orderId: order.id, kind: 'vin' })),
        CHECK,
        'seller_cards_vin_owner_check',
      );
      const [vinCard] = await db
        .insert(sellerCards)
        .values(card({ vinRequestId: vin.id, kind: 'vin' }))
        .returning();
      expect(vinCard).toMatchObject({ orderId: null, vinRequestId: vin.id, kind: 'vin' });
      await db.insert(sellerCards).values(card({ orderId: order.id, kind: 'qr' }));
    });
  });

  it('link_tokens default to the telegram channel', async () => {
    const user = await insertUser(db);
    const [token] = await db
      .insert(linkTokens)
      .values({ token: randomToken(), userId: user.id, expiresAt: new Date(Date.now() + 1000) })
      .returning();
    expect(token).toMatchObject({ channel: 'telegram', usedAt: null, usedByExternalId: null });
  });
});
