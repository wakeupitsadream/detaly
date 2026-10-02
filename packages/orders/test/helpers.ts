// Test helpers of @detaly/orders: the database of the project (`${DATABASE_URL_TEST}_orders`),
// engine deps with a controllable clock, an order factory (seedOrder) and provider objects.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  createDb,
  eq,
  orderEvents,
  orderItems,
  orders,
  outbox,
  payments,
  receipts,
  settings,
  sql,
  users,
  type Db,
} from '@detaly/db';
import { testEnv } from '@detaly/db/testing';
import {
  buildPaymentReceipt,
  type Offer,
  type OrderItemState,
  type OrderStatus,
  type PaymentKind,
  type PaymentScheme,
  type PaymentStatus,
  type ReceiptStatus,
} from '@detaly/domain';
import type { ProviderReceipt, ProviderRefund } from '@detaly/payments';
import { v7 as uuidv7 } from 'uuid';
import { inject } from 'vitest';
import type { EngineDeps, ProviderPaymentLike } from '../src';

export const DB_URL = inject('ordersDatabaseUrl');

export const PAYMENT_ENV = {
  YOOKASSA_SHOP_ID: 'test-shop',
  YOOKASSA_SECRET_KEY: 'test-secret',
  YOOKASSA_VAT_CODE: '1',
  YOOKASSA_TAX_SYSTEM_CODE: '2',
  APP_BASE_URL: 'https://detaly.test',
};

export function openDb(): Db {
  if (!DB_URL) throw new Error('DATABASE_URL_TEST is not set');
  return createDb(DB_URL, { max: 8 });
}

export interface TestClock {
  now: Date;
  advance(ms: number): void;
}

export const T0 = new Date('2026-10-05T07:00:00.000Z');

export function testClock(start: Date = T0): TestClock {
  const clock = {
    now: new Date(start),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  return clock;
}

export function makeDeps(
  db: Db,
  options: {
    env?: Record<string, string | undefined>;
    clock?: TestClock;
    nudges?: { count: number };
  } = {},
): EngineDeps {
  const clock = options.clock ?? testClock();
  return {
    db,
    env: testEnv({ ...PAYMENT_ENV, ...options.env }),
    now: () => clock.now,
    nudge: () => {
      if (options.nudges) options.nudges.count += 1;
    },
  };
}

export function randomPhone(): string {
  return `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

export function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    source: 'rossko',
    brand: 'MANN',
    article: 'W 914/2',
    articleNorm: 'W9142',
    name: 'Фильтр масляный',
    group: null,
    isCross: false,
    priceSupplierKop: 100_000,
    stock: {
      stockId: 'ORB1',
      isLocal: true,
      count: 4,
      multiplicity: 1,
      type: null,
      deliveryDays: 2,
      deliveryStart: null,
      deliveryEnd: null,
      extra: null,
      description: null,
    },
    ...overrides,
  };
}

export interface SeedItem {
  brand?: string;
  article?: string;
  qty?: number;
  priceClientKop?: number;
  priceSupplierKop?: number;
  state?: OrderItemState;
  etaDate?: string | null;
  isLocal?: boolean;
  refundedAmountKop?: number;
}

export interface SeedOrderOptions {
  scheme?: PaymentScheme;
  status?: OrderStatus;
  items?: SeedItem[];
  courierFeeKop?: number;
  /**
   * The order's payment. Default: a succeeded prepayment of the total for prepay orders past
   * awaiting_payment, none otherwise. null: no payment.
   */
  payment?: {
    kind?: PaymentKind;
    status?: PaymentStatus;
    amountKop?: number;
    receiptStatus?: ReceiptStatus;
  } | null;
  clientArrived?: boolean;
  expiresAt?: Date | null;
  receivedAt?: Date | null;
  /** Status of an offset receipt to create (prepay). */
  offset?: ReceiptStatus | null;
  noShowCount?: number;
  phone?: string;
  attentionReason?: string | null;
}

export interface SeededOrder {
  orderId: string;
  userId: string;
  number: string;
  itemIds: string[];
  paymentId: string | null;
  providerPaymentId: string | null;
  totalKop: number;
  phone: string;
}

const DEFAULT_ITEMS: SeedItem[] = [
  { brand: 'MANN', article: 'W 914/2', priceClientKop: 128_000, priceSupplierKop: 100_000 },
  { brand: 'BOSCH', article: 'F 026', priceClientKop: 64_000, priceSupplierKop: 50_000 },
];

const PAID_STATUSES: readonly OrderStatus[] = [
  'confirmed',
  'ordering',
  'awaiting_supplier_invoice',
  'ordered_at_supplier',
  'needs_attention',
  'awaiting_client_approval',
  'ready',
  'handed',
  'completed',
  'refund_pending',
  'refunded',
];

function defaultItemState(status: OrderStatus): OrderItemState {
  if (status === 'ordered_at_supplier' || status === 'awaiting_supplier_invoice') return 'ordered';
  if (status === 'ready' || status === 'awaiting_handover_payment') return 'arrived';
  if (status === 'handed' || status === 'completed') return 'handed';
  return 'pending';
}

/** Inserts a user, an order with items and (by default) its payment, directly in a status. */
export async function seedOrder(db: Db, options: SeedOrderOptions = {}): Promise<SeededOrder> {
  const scheme = options.scheme ?? 'prepay';
  const status = options.status ?? 'confirmed';
  const items = options.items ?? DEFAULT_ITEMS;
  const phone = options.phone ?? randomPhone();
  const courierFeeKop = options.courierFeeKop ?? 0;
  const subtotal = items.reduce((s, i) => s + (i.priceClientKop ?? 10_000) * (i.qty ?? 1), 0);
  const totalKop = subtotal + courierFeeKop;

  const [user] = await db
    .insert(users)
    .values({ phone, noShowCount: options.noShowCount ?? 0 })
    .returning({ id: users.id });
  const userId = (user as { id: string }).id;
  const [order] = await db
    .insert(orders)
    .values({
      userId,
      accessToken: randomBytes(32).toString('base64url'),
      status,
      paymentScheme: scheme,
      subtotalKop: subtotal,
      courierFeeKop,
      totalKop,
      itemsHash: 'test',
      clientArrivedAt: options.clientArrived ? T0 : null,
      expiresAt: options.expiresAt ?? null,
      receivedAt: options.receivedAt ?? null,
      attentionReason: options.attentionReason ?? null,
    })
    .returning({ id: orders.id, number: orders.number });
  const { id: orderId, number } = order as { id: string; number: string };

  const itemIds: string[] = [];
  const itemRows = [];
  for (const [i, item] of items.entries()) {
    const id = uuidv7();
    itemIds.push(id);
    const brand = item.brand ?? `BR${i}`;
    const article = item.article ?? `ART ${i}`;
    const articleNorm = article.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const priceSupplierKop = item.priceSupplierKop ?? 8_000;
    const o = offer({ brand, article, articleNorm, priceSupplierKop });
    const row = {
      id,
      orderId,
      offerKey: `${articleNorm}:${brand}:ORB1`,
      searchArticleNorm: articleNorm,
      brand,
      article,
      name: 'Фильтр масляный',
      qty: item.qty ?? 1,
      stockId: 'ORB1',
      isLocal: item.isLocal ?? true,
      priceSupplierAtOrderKop: priceSupplierKop,
      priceClientKop: item.priceClientKop ?? 10_000,
      markupBp: 2800,
      etaDate: item.etaDate === undefined ? '2026-10-08' : item.etaDate,
      offerSnapshot: o,
      state: item.state ?? defaultItemState(status),
      refundedAmountKop: item.refundedAmountKop ?? 0,
    } satisfies typeof orderItems.$inferInsert;
    itemRows.push(row);
  }
  await db.insert(orderItems).values(itemRows);

  let paymentId: string | null = null;
  let providerPaymentId: string | null = null;
  const wantPayment =
    options.payment !== null &&
    (options.payment !== undefined || (scheme === 'prepay' && PAID_STATUSES.includes(status)));
  if (wantPayment) {
    const p = options.payment ?? {};
    const kind = p.kind ?? (scheme === 'prepay' ? 'prepayment' : 'full');
    const paymentStatus = p.status ?? 'succeeded';
    paymentId = uuidv7();
    providerPaymentId = `pay-${randomUUID()}`;
    const receipt = buildPaymentReceipt({
      kind,
      items: itemRows.map((r) => ({
        orderItemId: r.id,
        brand: r.brand,
        article: r.article,
        name: r.name,
        qty: r.qty,
        priceClientKop: r.priceClientKop,
        refundedAmountKop: 0,
        state: 'pending',
      })),
      courierFeeKop,
      phone,
      vatCode: 1,
      taxSystemCode: 2,
    });
    const idempotenceKey = uuidv7();
    await db.insert(payments).values({
      id: paymentId,
      orderId,
      kind,
      status: paymentStatus,
      amountKop: p.amountKop ?? totalKop,
      idempotenceKey,
      providerPaymentId,
      confirmationType: 'redirect',
      confirmationUrl: 'https://yoomoney.test/checkout',
      request: { orderId, amountKop: totalKop, idempotenceKey, receipt: receipt.data },
      paidAt: paymentStatus === 'succeeded' ? T0 : null,
    });
    await db.insert(receipts).values({
      orderId,
      paymentId,
      kind,
      idempotenceKey: `${idempotenceKey}:receipt`,
      status: p.receiptStatus ?? (paymentStatus === 'succeeded' ? 'succeeded' : 'pending'),
      request: receipt.data,
    });
  }
  if (options.offset && paymentId) {
    await db.insert(receipts).values({
      orderId,
      paymentId,
      kind: 'offset',
      idempotenceKey: uuidv7(),
      status: options.offset,
    });
  }
  return { orderId, userId, number, itemIds, paymentId, providerPaymentId, totalKop, phone };
}

export async function orderRow(db: Db, orderId: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!row) throw new Error('order not found');
  return row;
}

export async function itemRows(db: Db, orderId: string) {
  return db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.createdAt, orderItems.id);
}

export async function outboxOf(db: Db, orderId: string) {
  return db
    .select()
    .from(outbox)
    .where(sql`${outbox.data}->>'orderId' = ${orderId}`)
    .orderBy(outbox.createdAt, outbox.id);
}

export async function eventsOf(db: Db, orderId: string) {
  return db
    .select()
    .from(orderEvents)
    .where(eq(orderEvents.orderId, orderId))
    .orderBy(orderEvents.createdAt, orderEvents.id);
}

/** Sets a settings value and returns a function restoring the previous one. */
export async function setSetting(
  db: Db,
  key: string,
  value: unknown,
): Promise<() => Promise<void>> {
  const [prev] = await db.select().from(settings).where(eq(settings.key, key));
  await db
    .insert(settings)
    .values({ key, value, updatedBy: 'test' })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  return async () => {
    if (prev) await db.update(settings).set({ value: prev.value }).where(eq(settings.key, key));
    else await db.delete(settings).where(eq(settings.key, key));
  };
}

export function providerPayment(
  id: string,
  overrides: Partial<ProviderPaymentLike> = {},
): ProviderPaymentLike {
  const status = overrides.status ?? 'succeeded';
  return {
    id,
    status,
    paid: status === 'succeeded',
    amountKop: 192_000,
    confirmationUrl: null,
    confirmationData: null,
    createdAt: T0.toISOString(),
    expiresAt: null,
    method: 'bank_card',
    metadata: {},
    test: true,
    raw: { id, status },
    ...overrides,
  };
}

export function providerRefund(
  id: string,
  overrides: Partial<ProviderRefund> & Pick<ProviderRefund, 'paymentId' | 'amountKop'>,
): ProviderRefund {
  const status = overrides.status ?? 'succeeded';
  return {
    id,
    status,
    createdAt: T0.toISOString(),
    receiptRegistration: null,
    cancellationReason: null,
    raw: { id, status, receipt_registration: 'succeeded' },
    ...overrides,
  };
}

export function providerReceipt(
  id: string,
  overrides: Partial<ProviderReceipt> = {},
): ProviderReceipt {
  return {
    id,
    type: 'payment',
    status: 'succeeded',
    paymentId: null,
    refundId: null,
    fiscalDocumentNumber: '12345',
    paymentMode: null,
    settlementTypes: [],
    registeredAt: null,
    raw: { id },
    ...overrides,
  };
}

/** Phone digits must never appear in journal payloads or outbox data. */
export function assertNoPhone(value: unknown, phone: string): void {
  const text = JSON.stringify(value);
  if (text.includes(phone) || text.includes(phone.replace(/^\+/, ''))) {
    throw new Error('phone found in journal/outbox data');
  }
}
