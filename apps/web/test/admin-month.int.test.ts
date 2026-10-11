// Step 7 (docs/month-close.md): /admin/month, its act CSV and rates, /admin/returns and
// /admin/stock against PG with the msw emulation of YooKassa (reached through the adapter's
// injected fetch). A database of its own (`<web db>_month`): the month figures sum every row of a
// month and the rates are one setting, so the shared web database is never touched. March 2025
// in Asia/Yekaterinburg is [2025-02-28T19:00Z, 2025-03-31T19:00Z).
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  asc,
  createDb,
  eq,
  financeReconciliations,
  orderEvents,
  orderItems,
  orders,
  payments,
  receipts,
  refunds,
  settings,
  settingsAudit,
  stockItems,
  supplierReturns,
  users,
  type Db,
} from '@detaly/db';
import { prepareTestDb } from '@detaly/db/testing';
import {
  CONTRACT_RATES_KEY,
  DEFAULT_CONTRACT_RATES,
  formatRub,
  type Offer,
  type OrderItemState,
  type OrderStatus,
} from '@detaly/domain';
import {
  listStockItems,
  listSupplierReturns,
  loadLatestReconciliation,
  type EngineDeps,
} from '@detaly/orders';
import { createPaymentsFromEnv, type Payments } from '@detaly/payments';
import { createYooKassaMock, type YooKassaMock } from '@detaly/payments/testing';
import { getResponse } from 'msw';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminMonth } from '@/components/admin/AdminMonth';
import { AdminReturns, AdminStock } from '@/components/admin/AdminReturns';
import { loadAdminMonth, loadAdminRates } from '@/server/admin/month';
import { handleAdminMonthAction, handleAdminMonthCsv } from '@/server/admin/month-handler';
import { handleAdminReturnsAction } from '@/server/admin/returns-handler';
import { intEnv, webDatabaseUrl } from './helpers';

const APP = 'http://127.0.0.1:3100';
const ADMIN = 'admin:month-test-password';
const AUTH = `Basic ${Buffer.from(ADMIN, 'utf8').toString('base64')}`;
const SHOP = { shopId: 'test-shop', secretKey: 'test-secret' } as const;
const env = intEnv({
  ADMIN_BASIC_AUTH: ADMIN,
  APP_BASE_URL: APP,
  YOOKASSA_SHOP_ID: SHOP.shopId,
  YOOKASSA_SECRET_KEY: SHOP.secretKey,
  YOOKASSA_VAT_CODE: '1',
  YOOKASSA_TAX_SYSTEM_CODE: '2',
});
const MONTH = '2025-03';
/** Inside March 2025 in Orenburg. */
const IN_MONTH = (day: number, hour = 6) =>
  new Date(`2025-03-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`);
const NOW = new Date('2025-04-02T05:00:00.000Z');
/** «Прибыль» and «доля» in any form never appear on these pages. */
const FORBIDDEN = /прибыл|(?<![а-яё])дол(?:я|и|ю|ей|ям|ями|ях)(?![а-яё])/iu;

let db: Db;
let mock: YooKassaMock;
let provider: Payments;

const mockFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const response = await getResponse(mock.handlers, request);
  if (response === undefined) throw new Error(`unhandled YooKassa request ${request.url}`);
  if (response.type === 'error') throw new TypeError('fetch failed');
  return response;
};

function engine(): EngineDeps {
  return { db, env, nudge: () => undefined };
}

function offer(brand: string, article: string): Offer {
  return {
    source: 'rossko',
    brand,
    article,
    articleNorm: article.replace(/[^A-Z0-9]/giu, '').toUpperCase(),
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
  };
}

interface Seeded {
  orderId: string;
  number: string;
  itemIds: string[];
}

async function seedOrder(input: {
  status: OrderStatus;
  itemState: OrderItemState;
  handedAt?: Date | null;
  deadline?: Date | null;
}): Promise<Seeded> {
  const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  const [user] = await db.insert(users).values({ phone }).returning({ id: users.id });
  const [order] = await db
    .insert(orders)
    .values({
      userId: user!.id,
      accessToken: randomBytes(32).toString('base64url'),
      status: input.status,
      paymentScheme: 'prepay',
      subtotalKop: 192_000,
      totalKop: 192_000,
      itemsHash: 'test',
      handedAt: input.handedAt ?? null,
      supplierReturnDeadlineAt: input.deadline ?? null,
    })
    .returning({ id: orders.id, number: orders.number });
  const itemIds: string[] = [];
  for (const [brand, article, clientKop, supplierKop] of [
    ['MANN', 'W 914/2', 128_000, 100_000],
    ['BOSCH', 'F 026', 64_000, 50_000],
  ] as const) {
    const [item] = await db
      .insert(orderItems)
      .values({
        orderId: order!.id,
        offerKey: `${article}:${brand}:ORB1`,
        searchArticleNorm: article.replace(/[^A-Z0-9]/giu, ''),
        brand,
        article,
        name: 'Фильтр масляный',
        qty: 1,
        stockId: 'ORB1',
        isLocal: true,
        priceSupplierAtOrderKop: supplierKop,
        priceClientKop: clientKop,
        markupBp: 2800,
        offerSnapshot: offer(brand, article),
        state: input.itemState,
      })
      .returning({ id: orderItems.id });
    itemIds.push(item!.id);
  }
  return { orderId: order!.id, number: order!.number, itemIds };
}

async function journal(
  orderId: string,
  type: string,
  createdAt: Date,
  extra: { toStatus?: OrderStatus; payload?: Record<string, unknown> } = {},
) {
  await db.insert(orderEvents).values({
    orderId,
    type,
    toStatus: extra.toStatus ?? null,
    actorType: 'system',
    actorId: 'test',
    payload: extra.payload ?? {},
    createdAt,
  });
}

function formRequest(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  const all: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: APP,
    authorization: AUTH,
    ...headers,
  };
  for (const [key, value] of Object.entries(all)) if (value === '') delete all[key];
  return new Request(`${APP}${path}`, {
    method: 'POST',
    headers: all,
    body: new URLSearchParams(fields).toString(),
  });
}

function doneOf(response: Response): string {
  const location = response.headers.get('location') ?? '';
  return new URL(location, APP).searchParams.get('done') ?? '';
}

function monthDeps(overrides: { provider?: Payments['payments'] | null } = {}) {
  return {
    db,
    env,
    provider: overrides.provider === undefined ? provider.payments : overrides.provider,
    now: () => NOW,
  };
}

const text = (html: string) => html.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ');

/** A payment created at the YooKassa emulation (its created_at is the mock's clock). */
async function remotePayment(orderId: string, orderNumber: string, amountKop: number) {
  return provider.payments.createPayment({
    orderId,
    orderNumber,
    amountKop,
    idempotenceKey: randomUUID(),
    returnUrl: `${APP}/o/test?paid=1`,
    receipt: {
      customer: { phone: '79990000000' },
      lines: [
        {
          description: 'MANN W 914/2 Фильтр масляный',
          quantity: 1,
          measure: 'piece',
          unitPriceKop: amountKop,
          vatCode: 1,
          paymentSubject: 'commodity',
          paymentMode: 'full_prepayment',
        },
      ],
      taxSystemCode: 2,
    },
  });
}

let handed: Seeded;
let paymentId: string;

beforeAll(async () => {
  const base = new URL(webDatabaseUrl());
  base.pathname = `${base.pathname}_month`;
  const { url } = await prepareTestDb({ url: base.toString() });
  db = createDb(url, { max: 4 });
  mock = createYooKassaMock({ ...SHOP });
  const created = createPaymentsFromEnv(env, { fetch: mockFetch, timeoutMs: 5_000 });
  if (created === null) throw new Error('payments should be enabled');
  provider = created;

  // March 2025: one prepay order handed on the 12th (both parts), paid on the 10th.
  handed = await seedOrder({ status: 'handed', itemState: 'handed', handedAt: IN_MONTH(12) });
  mock.configure({ now: () => IN_MONTH(10) });
  const remote = await remotePayment(handed.orderId, handed.number, 192_000);
  mock.setPaymentStatus(remote.id, 'succeeded');
  const [payment] = await db
    .insert(payments)
    .values({
      orderId: handed.orderId,
      providerPaymentId: remote.id,
      kind: 'prepayment',
      status: 'succeeded',
      amountKop: 192_000,
      idempotenceKey: randomUUID(),
      paidAt: IN_MONTH(10),
      createdAt: IN_MONTH(10),
    })
    .returning({ id: payments.id });
  paymentId = payment!.id;
  const [receipt] = await db
    .insert(receipts)
    .values({
      orderId: handed.orderId,
      paymentId,
      kind: 'prepayment',
      idempotenceKey: randomUUID(),
      status: 'succeeded',
    })
    .returning({ id: receipts.id });
  await journal(handed.orderId, 'receipt_succeeded', IN_MONTH(10, 7), {
    payload: { receiptId: receipt!.id },
  });
  await journal(handed.orderId, 'item_arrived', IN_MONTH(11), {
    payload: { itemId: handed.itemIds[0] },
  });
  await journal(handed.orderId, 'item_arrived', IN_MONTH(11, 7), {
    payload: { itemId: handed.itemIds[1] },
  });
  await journal(handed.orderId, 'handed_over', IN_MONTH(12), { toStatus: 'handed' });

  // Rossko paid back 500 ₽ for a returned part on the 20th: not income.
  const returned = await seedOrder({ status: 'cancelled', itemState: 'refunded' });
  await db.insert(supplierReturns).values({
    orderItemId: returned.itemIds[1]!,
    kind: 'return',
    status: 'refunded',
    amountExpectedKop: 50_000,
    amountReceivedKop: 50_000,
    shippedAt: IN_MONTH(15),
    refundedAt: IN_MONTH(20),
  });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  mock.configure({ now: () => IN_MONTH(25) });
});

describe('/admin/month', () => {
  it('shows every section from the stored rows', async () => {
    const data = await loadAdminMonth(db, env, MONTH, NOW, true);
    expect(data).toMatchObject({ month: MONTH, prev: '2025-02', next: '2025-04', running: false });
    expect(data.report.revenue.totalKop).toBe(192_000);
    // 1 920 − 1 500 − 53,76 (2,8%) = 366,24 ₽
    expect(data.report.margin.totals).toMatchObject({ marginKop: 36_624, marginBp: 1907 });
    expect(data.report.act.counts).toMatchObject({ receive: 2, handover: 1 });
    expect(data.report.supplierRefunds.totalKop).toBe(50_000);

    const html = renderToStaticMarkup(
      createElement(AdminMonth, { data, done: null, contractMissing: ['CONTRACT_NUMBER'] }),
    );
    for (const id of [
      'month-revenue',
      'month-margin',
      'month-act',
      'month-recon',
      'month-not-income',
      'month-rates',
      'month-rates-unset',
      'month-contract-missing',
      'month-recon-none',
      'month-bank-checklist',
    ]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
    expect(html).toMatch(
      new RegExp(`data-testid="month-revenue-total"><span[^>]*>${formatRub(192_000)}<`, 'u'),
    );
    expect(text(html)).toContain('Закрытие месяца: март 2025');
    expect(html).toContain('href="/admin/month/act?m=2025-03"');
    expect(html).toContain('href="/api/admin/month/csv?m=2025-03"');
    expect(html).toContain(`>${formatRub(50_000)}<`);
    expect(text(html)).not.toMatch(FORBIDDEN);
    // No tax amount anywhere: the only tax words are the neutral deadline.
    expect(text(html)).not.toMatch(/налог(?!а АУСН — до 25-го)/u);
  });

  it('«Сверить»: the month at YooKassa against the database, stored; errors shown, not thrown', async () => {
    // At YooKassa only: a payment of March nobody recorded.
    mock.configure({ now: () => IN_MONTH(14) });
    const stray = await remotePayment(randomUUID(), 'X-1', 10_000);
    // In the database only: a refund YooKassa does not know.
    await db.insert(refunds).values({
      orderId: handed.orderId,
      paymentId,
      providerRefundId: `rf-${randomUUID()}`,
      amountKop: 5_000,
      reason: 'refusal',
      status: 'succeeded',
      idempotenceKey: randomUUID(),
      requestedAt: IN_MONTH(16),
      deadlineAt: IN_MONTH(26),
      succeededAt: IN_MONTH(16),
      createdAt: IN_MONTH(16),
    });

    const response = await handleAdminMonthAction(
      formRequest('/api/admin/month', { action: 'reconcile', month: MONTH }),
      monthDeps(),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(/^\/admin\/month\?m=2025-03&done=/u);
    expect(doneOf(response)).toBe('Сверка за март 2025 сохранена: расхождений 2');
    const latest = await loadLatestReconciliation(db, MONTH);
    expect(latest?.createdBy).toBe('admin');
    expect(latest?.result.payments).toMatchObject({ dbCount: 1, providerCount: 2, matched: 1 });
    expect(latest?.result.payments?.differences).toEqual([
      expect.objectContaining({ kind: 'missing_in_db', id: stray.id, providerAmountKop: 10_000 }),
    ]);
    expect(latest?.result.refunds?.differences).toEqual([
      expect.objectContaining({
        kind: 'missing_at_provider',
        label: handed.number,
        dbAmountKop: 5_000,
      }),
    ]);

    const data = await loadAdminMonth(db, env, MONTH, NOW, true);
    const html = renderToStaticMarkup(
      createElement(AdminMonth, { data, done: null, contractMissing: [] }),
    );
    expect(html).toContain('data-testid="month-recon-result"');
    expect(text(html)).toContain('Есть в ЮKassa, нет в базе');
    expect(text(html)).toContain('Есть в базе, нет в ЮKassa');

    // YooKassa fails on the payment list: stored with the error, the page says so.
    mock.failNext('GET /payments', 500);
    const failed = await handleAdminMonthAction(
      formRequest('/api/admin/month', { action: 'reconcile', month: MONTH }),
      monthDeps(),
    );
    expect(failed.status).toBe(303);
    expect(doneOf(failed)).toMatch(
      /^Сверка за март 2025 сохранена с ошибками ЮKassa: Платежи: ЮKassa ответила ошибкой HTTP 500/u,
    );
    const second = await loadLatestReconciliation(db, MONTH);
    expect(second?.result.payments).toBeNull();
    expect(second?.result.refunds).not.toBeNull();
    expect(await db.select().from(financeReconciliations)).toHaveLength(2);

    // Without YooKassa there is nothing to compare with.
    const off = await handleAdminMonthAction(
      formRequest('/api/admin/month', { action: 'reconcile', month: MONTH }),
      monthDeps({ provider: null }),
    );
    expect(off.status).toBe(409);
    expect(await off.text()).toContain('ЮKassa не подключена');
  });

  it('refuses without the password, from a foreign page, for a month in the future', async () => {
    const noAuth = await handleAdminMonthAction(
      formRequest('/api/admin/month', { action: 'reconcile', month: MONTH }, { authorization: '' }),
      monthDeps(),
    );
    expect(noAuth.status).toBe(401);
    const foreign = await handleAdminMonthAction(
      formRequest(
        '/api/admin/month',
        { action: 'reconcile', month: MONTH },
        { origin: 'https://evil.example' },
      ),
      monthDeps(),
    );
    expect(foreign.status).toBe(403);
    const future = await handleAdminMonthAction(
      formRequest('/api/admin/month', { action: 'reconcile', month: '2025-05' }),
      monthDeps(),
    );
    expect(future.status).toBe(400);
    const unknown = await handleAdminMonthAction(
      formRequest('/api/admin/month', { action: 'nope', month: MONTH }),
      monthDeps(),
    );
    expect(unknown.status).toBe(400);
  });

  it('«Скачать CSV»: date, order, service, rate of every operation', async () => {
    const denied = await handleAdminMonthCsv(new Request(`${APP}/api/admin/month/csv?m=${MONTH}`), {
      db,
      env,
      now: () => NOW,
    });
    expect(denied.status).toBe(401);
    const response = await handleAdminMonthCsv(
      new Request(`${APP}/api/admin/month/csv?m=${MONTH}`, { headers: { authorization: AUTH } }),
      { db, env, now: () => NOW },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="act-2025-03.csv"',
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    const bytes = new Uint8Array(await response.arrayBuffer());
    // The UTF-8 byte order mark first: Excel then reads the Cyrillic right.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).trimEnd().split('\r\n');
    expect(lines[0]).toBe('Дата;Заказ;Операция;Ставка, ₽');
    expect(lines.slice(1)).toEqual([
      `11.03.2025 11:00;${handed.number};Приёмка детали от поставщика;0,00`,
      `11.03.2025 12:00;${handed.number};Приёмка детали от поставщика;0,00`,
      `12.03.2025 11:00;${handed.number};Выдача заказа покупателю;0,00`,
    ]);
  });
});

describe('/admin/month/rates', () => {
  const RATE_FIELDS = {
    action: 'rates',
    month: MONTH,
    storage: 'on',
    kop_receive: '5000',
    kop_store_day: '1000',
    kop_handover: '10000',
    kop_return_accept: '15000',
    kop_vin_selection: '20000',
    kop_fit_check: '7500',
    kop_claim_diagnostics: '30000',
    turnover_bp: '150',
  };

  it('saves through the audited writer behind the tick and the version', async () => {
    const before = await loadAdminRates(db, env, MONTH, {}, NOW);
    expect(before.rates).toEqual(DEFAULT_CONTRACT_RATES);
    expect(before.current.totalKop).toBe(0);

    const unticked = await handleAdminMonthAction(
      formRequest('/api/admin/month', { ...RATE_FIELDS, version: before.version }),
      monthDeps(),
    );
    expect(unticked.status).toBe(400);
    const malformed = await handleAdminMonthAction(
      formRequest('/api/admin/month', {
        ...RATE_FIELDS,
        kop_receive: '50,5',
        version: before.version,
        confirm: 'on',
      }),
      monthDeps(),
    );
    expect(malformed.status).toBe(422);

    // The preview of the draft: 2 × 50 ₽ + 1 × 100 ₽ + 1,5% of 1 920 ₽ = 228,80 ₽
    const draft = await loadAdminRates(
      db,
      env,
      MONTH,
      {
        draft: '1',
        storage: 'on',
        rate_receive: '50',
        rate_store_day: '10',
        rate_handover: '100',
        rate_return_accept: '150',
        rate_vin_selection: '200',
        rate_fit_check: '75',
        rate_claim_diagnostics: '300',
        turnover: '1,5',
      },
      NOW,
    );
    expect(draft.preview?.totalKop).toBe(10_000 + 10_000 + 2_880);

    const saved = await handleAdminMonthAction(
      formRequest('/api/admin/month', { ...RATE_FIELDS, version: before.version, confirm: 'on' }),
      monthDeps(),
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toMatch(/^\/admin\/month\/rates\?m=2025-03&done=/u);
    expect(doneOf(saved)).toBe(`Ставки сохранены. Акт за март 2025: ${formatRub(22_880)}`);
    const [row] = await db.select().from(settings).where(eq(settings.key, CONTRACT_RATES_KEY));
    expect(row?.value).toEqual({
      perOperationKop: {
        receive: 5_000,
        store_day: 1_000,
        handover: 10_000,
        return_accept: 15_000,
        vin_selection: 20_000,
        fit_check: 7_500,
        claim_diagnostics: 30_000,
      },
      turnoverBp: 150,
    });
    expect(row?.updatedBy).toBe('admin');
    const audit = await db
      .select()
      .from(settingsAudit)
      .where(eq(settingsAudit.key, CONTRACT_RATES_KEY))
      .orderBy(asc(settingsAudit.changedAt));
    expect(audit.at(-1)).toMatchObject({ oldValue: DEFAULT_CONTRACT_RATES, changedBy: 'admin' });

    // The old version is stale now; the same values again change nothing.
    const stale = await handleAdminMonthAction(
      formRequest('/api/admin/month', { ...RATE_FIELDS, version: before.version, confirm: 'on' }),
      monthDeps(),
    );
    expect(stale.status).toBe(409);
    const after = await loadAdminRates(db, env, MONTH, {}, NOW);
    expect(after.current.totalKop).toBe(22_880);
    const same = await handleAdminMonthAction(
      formRequest('/api/admin/month', { ...RATE_FIELDS, version: after.version, confirm: 'on' }),
      monthDeps(),
    );
    expect(doneOf(same)).toBe('Без изменений');

    // Back to the defaults for the other tests.
    await db
      .update(settings)
      .set({ value: DEFAULT_CONTRACT_RATES, updatedBy: 'seed' })
      .where(eq(settings.key, CONTRACT_RATES_KEY));
  });
});

describe('/admin/returns and /admin/stock', () => {
  const returnsDeps = () => ({ engine: engine(), env });

  it('«Сдал водителю», «Деньги вернулись», «Не берут», «Списать» — once each', async () => {
    const order = await seedOrder({
      status: 'cancelled',
      itemState: 'refund_pending',
      deadline: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const [first, second] = await db
      .insert(supplierReturns)
      .values(
        order.itemIds.map((orderItemId, i) => ({
          orderItemId,
          kind: 'return' as const,
          status: 'requested' as const,
          amountExpectedKop: i === 0 ? 100_000 : 50_000,
        })),
      )
      .returning({ id: supplierReturns.id, orderItemId: supplierReturns.orderItemId });
    const mann = first!.orderItemId === order.itemIds[0] ? first! : second!;
    const bosch = mann === first ? second! : first!;
    const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
      handleAdminReturnsAction(formRequest('/api/admin/returns', fields, headers), returnsDeps());

    // The page: overdue first, with the buttons.
    const listed = await listSupplierReturns(db, { now: new Date(), closedSince: new Date(0) });
    const mine = listed.filter((ret) => ret.orderId === order.orderId);
    expect(mine.map((ret) => ret.status)).toEqual(['requested', 'requested']);
    const page = renderToStaticMarkup(
      createElement(AdminReturns, { returns: mine, now: new Date(), done: null }),
    );
    expect(page).toContain('data-testid="returns-overdue"');
    expect(text(page)).toContain('Сдал водителю');
    expect(text(page)).toContain('Не берут');
    expect(text(page)).toContain('Деньги вернулись');

    const shipped = await post({
      action: 'ship',
      supplierReturnId: mann.id,
      back: '/admin/returns',
    });
    expect(shipped.status).toBe(303);
    expect(doneOf(shipped)).toBe('Сдано водителю: MANN W 914/2. Ждём деньги от Rossko');
    expect(doneOf(await post({ action: 'ship', supplierReturnId: mann.id }))).toMatch(
      /^Уже отмечено: MANN W 914\/2 сдан водителю/u,
    );

    expect(
      (await post({ action: 'refunded', supplierReturnId: mann.id, amountRub: 'много' })).status,
    ).toBe(422);
    const refunded = await post({
      action: 'refunded',
      supplierReturnId: mann.id,
      amountRub: '1 000,50',
    });
    expect(doneOf(refunded)).toBe(`Деньги вернулись: MANN W 914/2, ${formatRub(100_050)}`);
    const [mannRow] = await db
      .select()
      .from(supplierReturns)
      .where(eq(supplierReturns.id, mann.id));
    expect(mannRow).toMatchObject({ status: 'refunded', amountReceivedKop: 100_050 });
    expect(mannRow?.refundedAt).toBeInstanceOf(Date);
    expect(
      doneOf(await post({ action: 'refunded', supplierReturnId: mann.id, amountRub: '5' })),
    ).toMatch(/^Уже отмечено: за MANN W 914\/2 вернулось/u);

    const rejected = await post({ action: 'reject', supplierReturnId: bosch.id });
    expect(doneOf(rejected)).toBe(
      `Не берут: BOSCH F 026 — деталь на складе (${formatRub(50_000)})`,
    );
    expect(doneOf(await post({ action: 'reject', supplierReturnId: bosch.id }))).toBe(
      'Уже отмечено: BOSCH F 026 не берут, деталь на складе',
    );
    const stock = await db
      .select()
      .from(stockItems)
      .where(eq(stockItems.orderItemId, bosch.orderItemId));
    expect(stock).toHaveLength(1);
    expect(stock[0]).toMatchObject({
      costKop: 50_000,
      reason: 'Не принят поставщиком',
      writtenOffAt: null,
    });

    // The stock page and «Списать» behind the tick.
    const items = (await listStockItems(db, { includeWrittenOff: true })).filter(
      (item) => item.orderId === order.orderId,
    );
    const stockPage = renderToStaticMarkup(createElement(AdminStock, { items, done: null }));
    expect(text(stockPage)).toContain('Не принят поставщиком');
    expect(text(stockPage)).toContain('Списать');
    const unticked = await post({
      action: 'write_off',
      stockItemId: stock[0]!.id,
      back: '/admin/stock',
    });
    expect(unticked.status).toBe(400);
    const written = await post({
      action: 'write_off',
      stockItemId: stock[0]!.id,
      back: '/admin/stock',
      confirm: 'on',
    });
    expect(written.status).toBe(303);
    expect(written.headers.get('location')).toMatch(/^\/admin\/stock\?done=/u);
    const [writtenRow] = await db.select().from(stockItems).where(eq(stockItems.id, stock[0]!.id));
    expect(writtenRow?.writtenOffAt).toBeInstanceOf(Date);
    expect(
      doneOf(await post({ action: 'write_off', stockItemId: stock[0]!.id, confirm: 'on' })),
    ).toMatch(/^Уже списано: BOSCH F 026/u);

    // Refused: no password, a foreign page, an unknown action, a bad id; a closed return.
    expect(
      (await post({ action: 'ship', supplierReturnId: bosch.id }, { authorization: '' })).status,
    ).toBe(401);
    expect(
      (
        await post(
          { action: 'ship', supplierReturnId: bosch.id },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    expect((await post({ action: 'sell', supplierReturnId: bosch.id })).status).toBe(400);
    expect((await post({ action: 'ship', supplierReturnId: 'nope' })).status).toBe(400);
    const closed = await post({ action: 'ship', supplierReturnId: bosch.id });
    expect(closed.status).toBe(409);
    expect(await closed.text()).toContain('уже отмечено «Не берут»');
  });
});
