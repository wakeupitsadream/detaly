import { randomUUID } from 'node:crypto';
import { testDatabaseUrl } from '@detaly/config/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client';
import {
  cartItems,
  carts,
  messengerBindings,
  notifications,
  orderItems,
  orders,
  payments,
  refunds,
  staff,
  users,
  vinRequests,
  webhookEvents,
} from '../src/schema';
import {
  expectPgError,
  insertOrder,
  insertUser,
  randomPhone,
  randomToken,
  SAMPLE_OFFER,
} from './helpers';

const UNIQUE = '23505';
const CHECK = '23514';

let db: Db;

beforeAll(() => {
  db = createDb(testDatabaseUrl(), { max: 4 });
});

afterAll(async () => {
  await db?.close();
});

describe('ids and defaults', () => {
  it('generates uuid v7 ids in the application', async () => {
    const user = await insertUser(db);
    expect(user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(user.noShowCount).toBe(0);
    expect(user.createdAt).toBeInstanceOf(Date);
  });
});

describe('users', () => {
  it('rejects a duplicate phone (23505)', async () => {
    const phone = randomPhone();
    await insertUser(db, phone);
    await expectPgError(insertUser(db, phone), UNIQUE, 'users_phone_unique');
  });

  it('accepts E.164 and anonymized phones only', async () => {
    await expectPgError(insertUser(db, '89991234567'), CHECK, 'users_phone_check');
    const user = await insertUser(db);
    await db
      .update(users)
      .set({ phone: `anon:${user.id}`, name: null, anonymizedAt: new Date() })
      .where(eq(users.id, user.id));
  });

  it('rejects a negative no_show_count', async () => {
    await expectPgError(
      db.insert(users).values({ phone: randomPhone(), noShowCount: -1 }),
      CHECK,
      'users_no_show_count_check',
    );
  });
});

describe('orders', () => {
  it('numbers orders DT-000001 style from a sequence', async () => {
    const a = await insertOrder(db);
    const b = await insertOrder(db);
    expect(a.number).toMatch(/^DT-\d{6}$/);
    expect(b.number).toMatch(/^DT-\d{6}$/);
    expect(Number(b.number.slice(3))).toBe(Number(a.number.slice(3)) + 1);
  });

  it('formats the first value as DT-000001', async () => {
    const [row] = await db.$client<{ n: string }[]>`
      select 'DT-' || lpad(1::text, 6, '0') as n`;
    expect(row?.n).toBe('DT-000001');
    // The column default uses the same expression on nextval().
    const [col] = await db.$client<{ d: string }[]>`
      select column_default as d from information_schema.columns
      where table_name = 'orders' and column_name = 'number'`;
    expect(col?.d).toContain("lpad((nextval('order_number_seq'::regclass))::text, 6, '0'::text)");
  });

  it('fails loudly instead of truncating past DT-999999', async () => {
    const [row] = await db.$client<{ last: string | null }[]>`
      select last_value::text as last from pg_sequences where sequencename = 'order_number_seq'`;
    await db.$client`select setval('order_number_seq', 999999)`;
    try {
      await expectPgError(insertOrder(db), '2200H');
    } finally {
      if (row?.last) await db.$client`select setval('order_number_seq', ${Number(row.last)})`;
      else await db.$client`select setval('order_number_seq', 1, false)`;
    }
  });

  it('checks total_kop = subtotal_kop + courier_fee_kop (23514)', async () => {
    await expectPgError(
      insertOrder(db, { subtotalKop: 100_000, courierFeeKop: 20_000, totalKop: 110_000 }),
      CHECK,
      'orders_total_check',
    );
    const ok = await insertOrder(db, {
      fulfillment: 'courier',
      subtotalKop: 100_000,
      courierFeeKop: 20_000,
      totalKop: 120_000,
    });
    expect(ok.totalKop).toBe(120_000);
  });

  it('rejects negative money', async () => {
    await expectPgError(
      insertOrder(db, { subtotalKop: -100, courierFeeKop: 100, totalKop: 0 }),
      CHECK,
      'orders_subtotal_kop_check',
    );
  });

  it('rejects a duplicate access token', async () => {
    const token = randomToken();
    await insertOrder(db, { accessToken: token });
    await expectPgError(
      insertOrder(db, { accessToken: token }),
      UNIQUE,
      'orders_access_token_unique',
    );
  });

  it('checks item qty and refunded amount', async () => {
    const order = await insertOrder(db);
    const item = {
      orderId: order.id,
      brand: 'MANN',
      article: 'W 914/2',
      name: 'Фильтр масляный',
      qty: 2,
      stockId: 'ORB1',
      isLocal: true,
      priceSupplierAtOrderKop: 50_000,
      priceClientKop: 64_000,
      markupBp: 2800,
      offerSnapshot: SAMPLE_OFFER,
    };
    await expectPgError(
      db.insert(orderItems).values({ ...item, qty: 0 }),
      CHECK,
      'order_items_qty_check',
    );
    await expectPgError(
      db.insert(orderItems).values({ ...item, refundedAmountKop: 128_001 }),
      CHECK,
      'order_items_refunded_amount_le_line_check',
    );
    const [first] = await db.insert(orderItems).values(item).returning();
    const [second] = await db
      .insert(orderItems)
      .values({ ...item, qty: 1 })
      .returning();
    await db
      .update(orderItems)
      .set({ state: 'replaced', replacedByItemId: second!.id })
      .where(eq(orderItems.id, first!.id));
    const [stored] = await db.select().from(orderItems).where(eq(orderItems.id, first!.id));
    expect(stored?.offerSnapshot).toEqual(SAMPLE_OFFER);
  });
});

describe('payments and refunds', () => {
  const payment = (orderId: string, status: 'pending' | 'succeeded' | 'canceled') => ({
    orderId,
    kind: 'prepayment' as const,
    status,
    amountKop: 128_000,
    idempotenceKey: randomUUID(),
    providerPaymentId: randomUUID(),
  });

  it('allows only one succeeded payment per order (23505)', async () => {
    const order = await insertOrder(db);
    await db.insert(payments).values(payment(order.id, 'canceled'));
    await db.insert(payments).values(payment(order.id, 'succeeded'));
    await db.insert(payments).values(payment(order.id, 'pending'));
    await expectPgError(
      db.insert(payments).values(payment(order.id, 'succeeded')),
      UNIQUE,
      'payments_order_id_succeeded_unique',
    );
  });

  it('blocks a second succeeded payment set by an update too', async () => {
    const order = await insertOrder(db);
    await db.insert(payments).values(payment(order.id, 'succeeded'));
    const [late] = await db.insert(payments).values(payment(order.id, 'pending')).returning();
    await expectPgError(
      db.update(payments).set({ status: 'succeeded' }).where(eq(payments.id, late!.id)),
      UNIQUE,
      'payments_order_id_succeeded_unique',
    );
  });

  it('rejects duplicate idempotence keys and provider ids', async () => {
    const order = await insertOrder(db);
    const first = payment(order.id, 'pending');
    await db.insert(payments).values(first);
    await expectPgError(
      db
        .insert(payments)
        .values({ ...payment(order.id, 'pending'), idempotenceKey: first.idempotenceKey }),
      UNIQUE,
      'payments_idempotence_key_unique',
    );
    await expectPgError(
      db
        .insert(payments)
        .values({ ...payment(order.id, 'pending'), providerPaymentId: first.providerPaymentId }),
      UNIQUE,
      'payments_provider_payment_id_unique',
    );
  });

  it('rejects zero amounts and duplicate refund keys', async () => {
    const order = await insertOrder(db);
    await expectPgError(
      db.insert(payments).values({ ...payment(order.id, 'pending'), amountKop: 0 }),
      CHECK,
      'payments_amount_kop_check',
    );
    const [paid] = await db.insert(payments).values(payment(order.id, 'succeeded')).returning();
    const refund = {
      orderId: order.id,
      paymentId: paid!.id,
      amountKop: 64_000,
      reason: 'refusal' as const,
      idempotenceKey: randomUUID(),
      requestedAt: new Date(),
      deadlineAt: new Date(Date.now() + 10 * 86_400_000),
    };
    await db.insert(refunds).values(refund);
    await expectPgError(
      db.insert(refunds).values(refund),
      UNIQUE,
      'refunds_idempotence_key_unique',
    );
  });
});

describe('webhook_events', () => {
  it('rejects a duplicate (source, external_id, event_type) (23505)', async () => {
    const event = {
      source: 'yookassa' as const,
      externalId: randomUUID(),
      eventType: 'payment.succeeded',
      payload: { object: { id: 'x' } },
    };
    await db.insert(webhookEvents).values(event);
    await expectPgError(
      db.insert(webhookEvents).values(event),
      UNIQUE,
      'webhook_events_source_external_id_event_type_unique',
    );
    // Same object, another event type, is a different event.
    await db.insert(webhookEvents).values({ ...event, eventType: 'payment.canceled' });
    // ON CONFLICT DO NOTHING is how the webhook route dedupes.
    const again = await db.insert(webhookEvents).values(event).onConflictDoNothing().returning();
    expect(again).toHaveLength(0);
  });
});

describe('other constraints', () => {
  it('allows one primary messenger binding per user and unique external ids', async () => {
    const user = await insertUser(db);
    const binding = {
      userId: user.id,
      channel: 'telegram' as const,
      externalUserId: String(Date.now()),
      chatId: '1',
      isPrimary: true,
    };
    await db.insert(messengerBindings).values(binding);
    await expectPgError(
      db.insert(messengerBindings).values(binding),
      UNIQUE,
      'messenger_bindings_channel_external_user_id_unique',
    );
    await expectPgError(
      db
        .insert(messengerBindings)
        .values({ ...binding, channel: 'max', externalUserId: randomUUID() }),
      UNIQUE,
      'messenger_bindings_user_id_primary_unique',
    );
    await db
      .insert(messengerBindings)
      .values({ ...binding, channel: 'max', externalUserId: randomUUID(), isPrimary: false });
  });

  it('requires a recipient on notifications and dedupes by key', async () => {
    const user = await insertUser(db);
    await expectPgError(
      db.insert(notifications).values({ template: 'ping', dedupeKey: randomUUID() }),
      CHECK,
      'notifications_recipient_check',
    );
    const row = { userId: user.id, template: 'ping', dedupeKey: randomUUID() };
    await db.insert(notifications).values(row);
    await expectPgError(
      db.insert(notifications).values(row),
      UNIQUE,
      'notifications_dedupe_key_unique',
    );
  });

  it('links carts and VIN requests both ways (FK cycle) and cascades cart items', async () => {
    const user = await insertUser(db);
    const [request] = await db
      .insert(vinRequests)
      .values({ userId: user.id, phone: user.phone, vin: 'XTA21099043456789', needText: 'колодки' })
      .returning();
    const [cart] = await db
      .insert(carts)
      .values({ proposalToken: randomToken(), vinRequestId: request!.id })
      .returning();
    await db
      .update(vinRequests)
      .set({ proposalCartId: cart!.id, status: 'offered' })
      .where(eq(vinRequests.id, request!.id));
    await db.insert(cartItems).values({
      cartId: cart!.id,
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
    });
    await db.delete(carts).where(eq(carts.id, cart!.id));
    const items = await db.select().from(cartItems).where(eq(cartItems.cartId, cart!.id));
    expect(items).toHaveLength(0);
    const [after] = await db.select().from(vinRequests).where(eq(vinRequests.id, request!.id));
    expect(after?.proposalCartId).toBeNull();

    await expectPgError(
      db.insert(vinRequests).values({ phone: user.phone, vin: 'XTA21099043456O89', needText: 'x' }),
      CHECK,
      'vin_requests_vin_check',
    );
  });

  it('keeps staff telegram ids unique', async () => {
    const tgUserId = 9_000_000_000 + Math.floor(Math.random() * 1_000_000);
    await db.insert(staff).values({ name: 'A', role: 'seller', tgUserId });
    await expectPgError(
      db.insert(staff).values({ name: 'B', role: 'seller', tgUserId }),
      UNIQUE,
      'staff_tg_user_id_unique',
    );
    await expectPgError(
      db.insert(staff).values({ name: 'C', role: 'seller' }),
      CHECK,
      'staff_messenger_id_check',
    );
    await db.delete(staff).where(eq(staff.tgUserId, tgUserId));
  });

  it('stores timestamps as timestamptz', async () => {
    const [row] = await db.$client<{ t: string }[]>`
      select data_type as t from information_schema.columns
      where table_name = 'orders' and column_name = 'created_at'`;
    expect(row?.t).toBe('timestamp with time zone');
    const order = await insertOrder(db);
    const [selected] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(eq(orders.id, order.id));
    expect(selected?.n).toBe(1);
  });
});
