// Migration 0002_phase_1b (docs/phase-1b-implementation.md section 1): it applies over a
// database that already holds phase 1A data, and its constraints reject what they must.
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OUTBOX_QUEUES } from '@detaly/config';
import { testDatabaseUrl } from '@detaly/config/testing';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrateDb, MIGRATIONS_FOLDER, type Db } from '../src/client';
import { eq } from '../src/index';
import {
  clientApprovals,
  notifications,
  orderItems,
  outbox,
  OUTBOX_QUEUE_NAMES,
  payments,
  receipts,
  refunds,
  sellerCards,
  settings,
  supplierOrderItems,
  supplierOrders,
  webhookEvents,
} from '../src/schema';
import { dropDatabase, ensureDatabase } from '../src/testing';
import { expectPgError, insertOrder, randomToken, SAMPLE_OFFER } from './helpers';

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

describe('0002_phase_1b over phase 1A data', () => {
  const url = (() => {
    const base = new URL(testDatabaseUrl());
    base.pathname = `${base.pathname}_p1b_${randomBytes(4).toString('hex')}`;
    return base.toString();
  })();
  let db: Db;
  let phase1aDir: string;

  beforeAll(async () => {
    await ensureDatabase(url);
    db = createDb(url, { max: 3 });
    phase1aDir = await migrationsUpTo('0001_phase_1a');
  });

  afterAll(async () => {
    await db?.close();
    await dropDatabase(url);
    if (phase1aDir) await rm(phase1aDir, { recursive: true, force: true });
  });

  it('applies on a database with a 1A order, payment, receipt, refund and notification', async () => {
    await migrateDb(db, { migrationsFolder: phase1aDir });
    const userId = uuidv7();
    const orderId = uuidv7();
    const itemId = uuidv7();
    const paymentId = uuidv7();
    // Raw SQL: the TypeScript schema already describes the phase 1B columns.
    await db.$client`insert into users (id, phone) values (${userId}, '+79120000002')`;
    await db.$client`
      insert into orders
        (id, user_id, access_token, payment_scheme, subtotal_kop, total_kop, items_hash,
         status, checkout_key)
      values (${orderId}, ${userId}, ${randomToken()}, 'prepay', 128000, 128000, 'h',
              'awaiting_payment', ${uuidv7()})`;
    await db.$client`
      insert into order_items
        (id, order_id, offer_key, search_article_norm, brand, article, name, qty, stock_id,
         is_local, price_supplier_at_order_kop, price_client_kop, markup_bp, offer_snapshot)
      values (${itemId}, ${orderId}, 'W9142:MANN:ORB1', 'W9142', 'MANN', 'W 914/2', 'Фильтр',
              1, 'ORB1', true, 100000, 128000, 2800, ${JSON.stringify(SAMPLE_OFFER)}::jsonb)`;
    await db.$client`
      insert into order_events (id, order_id, type, from_status, to_status, actor_type, payload)
      values (${uuidv7()}, ${orderId}, 'checkout', 'draft', 'awaiting_payment', 'client',
              ${JSON.stringify({ deferredEffects: ['create_payment'] })}::jsonb)`;
    await db.$client`
      insert into payments (id, order_id, kind, status, amount_kop, idempotence_key)
      values (${paymentId}, ${orderId}, 'prepayment', 'succeeded', 128000, ${randomUUID()})`;
    await db.$client`
      insert into receipts (id, order_id, payment_id, kind, idempotence_key)
      values (${uuidv7()}, ${orderId}, ${paymentId}, 'prepayment', ${randomUUID()})`;
    await db.$client`
      insert into refunds
        (id, order_id, payment_id, amount_kop, reason, idempotence_key, requested_at, deadline_at)
      values (${uuidv7()}, ${orderId}, ${paymentId}, 1000, 'refusal', ${randomUUID()}, now(),
              now() + interval '10 days')`;
    await db.$client`
      insert into supplier_orders (id, order_id, attempt_no) values (${uuidv7()}, ${orderId}, 1)`;
    await db.$client`
      insert into notifications (id, user_id, order_id, template, dedupe_key)
      values (${uuidv7()}, ${userId}, ${orderId}, 'paid', ${randomUUID()})`;
    await db.$client`
      insert into webhook_events (id, source, external_id, event_type, payload)
      values (${uuidv7()}, 'yookassa', 'p-1', 'payment.succeeded', '{}'::jsonb)`;

    await migrateDb(db);

    const [refund] = await db.select().from(refunds);
    expect(refund).toMatchObject({ scope: 'order', request: null, error: null, alertedAt: null });
    const [receipt] = await db.select().from(receipts);
    expect(receipt).toMatchObject({ attempts: 0, firstAttemptAt: null, error: null });
    const [payment] = await db.select().from(payments);
    expect(payment).toMatchObject({ confirmationType: null, request: null, paidAt: null });
    const [supplier] = await db.select().from(supplierOrders);
    expect(supplier).toMatchObject({ status: 'sending', calledAt: null, invoiceNumber: null });
    const [item] = await db.select().from(orderItems);
    expect(item?.arrivedAt).toBeNull();
    const [notification] = await db.select().from(notifications);
    expect(notification?.chatId).toBeNull();
    const [webhook] = await db.select().from(webhookEvents);
    expect(webhook?.ip).toBeNull();
    const rows = await db.$client`select client_arrived_at from orders`;
    expect(rows).toEqual([{ client_arrived_at: null }]);
  });
});

describe('phase 1B constraints', () => {
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

  async function insertPayment(orderId: string, status: 'pending' | 'succeeded' = 'succeeded') {
    const [payment] = await db
      .insert(payments)
      .values({
        orderId,
        kind: 'prepayment',
        status,
        amountKop: 128_000,
        idempotenceKey: randomUUID(),
        providerPaymentId: randomUUID(),
      })
      .returning();
    if (!payment) throw new Error('payment not inserted');
    return payment;
  }

  it('seeds approval.timeout_h = 24', async () => {
    const [row] = await db.select().from(settings).where(eq(settings.key, 'approval.timeout_h'));
    expect(row?.value).toBe(24);
  });

  describe('outbox', () => {
    it('rejects a duplicate job_id (23505)', async () => {
      const jobId = `notify:${randomUUID()}:paid`;
      await db.insert(outbox).values({ queue: 'notify', name: 'order', jobId });
      await expectPgError(
        db.insert(outbox).values({ queue: 'notify', name: 'order', jobId }),
        UNIQUE,
        'outbox_job_id_unique',
      );
      // insert ... on conflict do nothing returning: the engine's "already queued" signal
      const again = await db
        .insert(outbox)
        .values({ queue: 'notify', name: 'order', jobId })
        .onConflictDoNothing({ target: outbox.jobId })
        .returning({ id: outbox.id });
      expect(again).toEqual([]);
    });

    it('accepts every outbox queue of @detaly/config and nothing else (23514)', async () => {
      expect([...OUTBOX_QUEUE_NAMES]).toEqual([...OUTBOX_QUEUES]);
      for (const queue of OUTBOX_QUEUES) {
        await db.insert(outbox).values({ queue, name: 'x', jobId: `q:${randomUUID()}` });
      }
      for (const queue of ['dead-letter', 'unknown', '']) {
        await expectPgError(
          db.insert(outbox).values({ queue, name: 'x', jobId: `q:${randomUUID()}` }),
          CHECK,
          'outbox_queue_check',
        );
      }
    });

    it('defaults: empty data, available now, not dispatched, 0 attempts', async () => {
      const [row] = await db
        .insert(outbox)
        .values({ queue: 'rossko', name: 'checkout', jobId: `checkout:${randomUUID()}` })
        .returning();
      expect(row).toMatchObject({ data: {}, dispatchedAt: null, attempts: 0, lastError: null });
      expect(row?.availableAt).toBeInstanceOf(Date);
    });
  });

  describe('client_approvals', () => {
    const proposal = { kind: 'new_eta' as const, etaDate: '2026-10-20', note: null };

    it('one open approval per order (23505); a decided one does not count', async () => {
      const order = await insertOrder(db);
      const [first] = await db
        .insert(clientApprovals)
        .values({ orderId: order.id, kind: 'new_eta', scope: 'order', proposal })
        .returning();
      await expectPgError(
        db
          .insert(clientApprovals)
          .values({ orderId: order.id, kind: 'new_eta', scope: 'order', proposal }),
        UNIQUE,
        'client_approvals_order_open_unique',
      );
      await db
        .update(clientApprovals)
        .set({ decidedAt: new Date(), decision: 'approved' })
        .where(eq(clientApprovals.id, first!.id));
      await db
        .insert(clientApprovals)
        .values({ orderId: order.id, kind: 'new_eta', scope: 'order', proposal });
    });

    it("scope 'item' requires order_item_id and 'order' forbids it (23514)", async () => {
      const order = await insertOrder(db);
      const item = await insertItem(order.id);
      await expectPgError(
        db
          .insert(clientApprovals)
          .values({ orderId: order.id, kind: 'new_eta', scope: 'item', proposal }),
        CHECK,
        'client_approvals_scope_item_check',
      );
      await expectPgError(
        db.insert(clientApprovals).values({
          orderId: order.id,
          orderItemId: item.id,
          kind: 'new_eta',
          scope: 'order',
          proposal,
        }),
        CHECK,
        'client_approvals_scope_item_check',
      );
      await expectPgError(
        db
          .insert(clientApprovals)
          .values({ orderId: order.id, kind: 'new_eta', scope: 'all', proposal }),
        CHECK,
        'client_approvals_scope_check',
      );
      await expectPgError(
        db.insert(clientApprovals).values({
          orderId: order.id,
          kind: 'new_eta',
          scope: 'order',
          proposal,
          decision: 'timeout',
        }),
        CHECK,
        'client_approvals_decision_check',
      );
      await db.insert(clientApprovals).values({
        orderId: order.id,
        orderItemId: item.id,
        kind: 'new_eta',
        scope: 'item',
        proposal,
      });
    });
  });

  it('one sending supplier order per order (23505); created ones do not count', async () => {
    const order = await insertOrder(db);
    await db.insert(supplierOrders).values({ orderId: order.id, attemptNo: 1, status: 'created' });
    await db.insert(supplierOrders).values({ orderId: order.id, attemptNo: 2 });
    await expectPgError(
      db.insert(supplierOrders).values({ orderId: order.id, attemptNo: 3 }),
      UNIQUE,
      'supplier_orders_order_sending_unique',
    );
    await expectPgError(
      db
        .insert(supplierOrders)
        .values({ orderId: order.id, attemptNo: 4, status: 'failed', invoiceAmountKop: -1 }),
      CHECK,
      'supplier_orders_invoice_amount_kop_check',
    );
  });

  it('one not-canceled offset receipt per order; after canceled a new one is allowed', async () => {
    const order = await insertOrder(db);
    const payment = await insertPayment(order.id);
    const offset = () => ({
      orderId: order.id,
      paymentId: payment.id,
      kind: 'offset' as const,
      idempotenceKey: randomUUID(),
    });
    const [first] = await db.insert(receipts).values(offset()).returning();
    await expectPgError(
      db.insert(receipts).values(offset()),
      UNIQUE,
      'receipts_order_offset_unique',
    );
    await db.update(receipts).set({ status: 'canceled' }).where(eq(receipts.id, first!.id));
    const [second] = await db.insert(receipts).values(offset()).returning();
    expect(second?.attempts).toBe(0);
    await expectPgError(
      db.update(receipts).set({ attempts: -1 }).where(eq(receipts.id, second!.id)),
      CHECK,
      'receipts_attempts_check',
    );
  });

  it('one prepayment/full receipt per payment (23505)', async () => {
    const order = await insertOrder(db);
    const payment = await insertPayment(order.id, 'pending');
    const row = () => ({
      orderId: order.id,
      paymentId: payment.id,
      kind: 'prepayment' as const,
      idempotenceKey: randomUUID(),
    });
    await db.insert(receipts).values(row());
    await expectPgError(db.insert(receipts).values(row()), UNIQUE, 'receipts_payment_kind_unique');
  });

  it('two succeeded payments of one order can be recorded now (decision Б8)', async () => {
    const order = await insertOrder(db);
    await insertPayment(order.id);
    await insertPayment(order.id);
    await expectPgError(
      db.insert(payments).values({
        orderId: order.id,
        kind: 'full',
        amountKop: 1,
        idempotenceKey: randomUUID(),
        confirmationType: 'sms',
      }),
      CHECK,
      'payments_confirmation_type_check',
    );
  });

  it('refunds.scope defaults to order and accepts item / orphan', async () => {
    const order = await insertOrder(db);
    const payment = await insertPayment(order.id);
    const refund = (scope?: 'item' | 'orphan') => ({
      orderId: order.id,
      paymentId: payment.id,
      amountKop: 1_000,
      reason: 'supplier_fail' as const,
      idempotenceKey: randomUUID(),
      requestedAt: new Date(),
      deadlineAt: new Date(Date.now() + 10 * 86_400_000),
      ...(scope ? { scope } : {}),
    });
    const [a] = await db.insert(refunds).values(refund()).returning();
    const [b] = await db.insert(refunds).values(refund('item')).returning();
    const [c] = await db.insert(refunds).values(refund('orphan')).returning();
    expect([a?.scope, b?.scope, c?.scope]).toEqual(['order', 'item', 'orphan']);
  });

  it('notifications: chat_id alone is a recipient, no recipient -> 23514', async () => {
    await db
      .insert(notifications)
      .values({ chatId: '-1001234567890', template: 'staff_new_order', dedupeKey: randomUUID() });
    await expectPgError(
      db.insert(notifications).values({ template: 'staff_new_order', dedupeKey: randomUUID() }),
      CHECK,
      'notifications_recipient_check',
    );
  });

  it('seller_cards: nonce of 8 base64url characters, unique; kind order|qr (23514)', async () => {
    const order = await insertOrder(db);
    const card = (nonce: string, kind = 'order') => ({
      orderId: order.id,
      chatId: '-100123',
      nonce,
      kind,
    });
    const nonce = randomBytes(6).toString('base64url');
    expect(nonce).toHaveLength(8);
    await db.insert(sellerCards).values(card(nonce));
    await expectPgError(
      db.insert(sellerCards).values(card(nonce)),
      UNIQUE,
      'seller_cards_nonce_unique',
    );
    for (const bad of ['short', 'nine_char', 'abc+/=12', 'абвгдежз']) {
      await expectPgError(
        db.insert(sellerCards).values(card(bad)),
        CHECK,
        'seller_cards_nonce_check',
      );
    }
    await expectPgError(
      db.insert(sellerCards).values(card(randomBytes(6).toString('base64url'), 'menu')),
      CHECK,
      'seller_cards_kind_check',
    );
  });

  it('webhook_events.ip stores IPv4 and IPv6 as inet', async () => {
    const row = (ip: string) => ({
      source: 'yookassa' as const,
      externalId: randomUUID(),
      eventType: 'payment.succeeded',
      payload: {},
      ip,
    });
    await db.insert(webhookEvents).values(row('185.71.76.1'));
    await db.insert(webhookEvents).values(row('2a02:5180::1'));
    await expectPgError(db.insert(webhookEvents).values(row('not-an-ip')), '22P02');
  });

  it('relations load approvals, cards, supplier orders with items, receipts and refunds', async () => {
    const order = await insertOrder(db);
    const item = await insertItem(order.id);
    const payment = await insertPayment(order.id);
    await db.insert(receipts).values({
      orderId: order.id,
      paymentId: payment.id,
      kind: 'prepayment',
      idempotenceKey: randomUUID(),
    });
    const [refund] = await db
      .insert(refunds)
      .values({
        orderId: order.id,
        paymentId: payment.id,
        amountKop: 128_000,
        reason: 'refusal',
        idempotenceKey: randomUUID(),
        requestedAt: new Date(),
        deadlineAt: new Date(),
      })
      .returning();
    await db.insert(receipts).values({
      orderId: order.id,
      paymentId: payment.id,
      refundId: refund!.id,
      kind: 'refund_prepayment',
      idempotenceKey: randomUUID(),
    });
    const [supplier] = await db
      .insert(supplierOrders)
      .values({ orderId: order.id, attemptNo: 1 })
      .returning();
    await db
      .insert(supplierOrderItems)
      .values({ supplierOrderId: supplier!.id, orderItemId: item.id });
    await db.insert(clientApprovals).values({
      orderId: order.id,
      orderItemId: item.id,
      kind: 'new_eta',
      scope: 'item',
      proposal: { kind: 'new_eta', etaDate: '2026-10-20', note: null },
    });
    await db.insert(sellerCards).values({
      orderId: order.id,
      chatId: '-1',
      nonce: randomBytes(6).toString('base64url'),
      kind: 'order',
    });

    const loaded = await db.query.orders.findFirst({
      where: (t, ops) => ops.eq(t.id, order.id),
      with: {
        payments: { with: { receipts: { columns: { kind: true } }, refunds: true } },
        receipts: { columns: { kind: true } },
        refunds: { with: { receipts: { columns: { kind: true } } } },
        supplierOrders: { with: { items: { with: { orderItem: { columns: { id: true } } } } } },
        approvals: { with: { item: { columns: { id: true } } } },
        sellerCards: { columns: { kind: true } },
        items: { with: { supplierOrderItems: true } },
      },
    });
    expect(loaded?.payments[0]?.receipts.map((r) => r.kind).sort()).toEqual([
      'prepayment',
      'refund_prepayment',
    ]);
    expect(loaded?.payments[0]?.refunds).toHaveLength(1);
    expect(loaded?.receipts).toHaveLength(2);
    expect(loaded?.refunds[0]?.receipts).toEqual([{ kind: 'refund_prepayment' }]);
    expect(loaded?.supplierOrders[0]?.items[0]?.orderItem).toEqual({ id: item.id });
    expect(loaded?.approvals[0]?.item).toEqual({ id: item.id });
    expect(loaded?.sellerCards).toEqual([{ kind: 'order' }]);
    expect(loaded?.items[0]?.supplierOrderItems).toHaveLength(1);
  });
});
