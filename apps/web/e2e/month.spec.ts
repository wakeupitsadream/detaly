/**
 * Step 7 end to end (docs/month-close.md) on mobile 375x812 and desktop 1280x800.
 *
 *   /admin/month of a past month seeded straight into the database (two handed orders — one sold
 *   below cost —, their receipts and journal, Rossko's money for a returned part): revenue by
 *   receipts, the margin with the order in the red, the act with «Ставки не заданы», «Сверить»
 *   against the YooKassa emulation (the month's payments are only in the database: two
 *   differences), the rates editor (preview «сейчас → станет», «подтверждаю», save), the act
 *   with the new rates on screen and in print (the warnings are not printed), «Скачать CSV»;
 *   /admin/returns: «Сдал водителю», «Не берут», «Деньги вернулись»; /admin/stock: «Списать».
 *
 * The month is a free one of 2024–2025 (no journal events in it): every other spec writes into
 * the current month, so the figures are exactly the seeded ones. Everything seeded — and the
 * contract rates — is removed again after the test.
 *
 * Screenshots for a human look: test-results/step7/<project>-*.png.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  and,
  createDb,
  eq,
  financeReconciliations,
  gte,
  inArray,
  lt,
  orderEvents,
  orderItems,
  orders,
  payments,
  receipts,
  settings,
  sql,
  stockItems,
  supplierReturns,
  users,
  type Db,
} from '@detaly/db';
import {
  addMonths,
  CONTRACT_RATES_KEY,
  DEFAULT_CONTRACT_RATES,
  monthBounds,
  monthTitle,
  type MonthKey,
  type OrderItemState,
  type OrderStatus,
  type PaymentScheme,
} from '@detaly/domain';
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, randomIp } from './helpers';

const ADMIN_USER = process.env.E2E_ADMIN_USER;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const DATABASE_URL = process.env.DATABASE_URL ?? null;
/** «прибыль» and «доля» in any form never appear in the act. */
const FORBIDDEN = /прибыл|(?<![а-яё])дол(?:я|и|ю|ей|ям|ями|ях)(?![а-яё])/iu;

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
});

async function shot(page: Page, project: string, slug: string): Promise<void> {
  await page.screenshot({ path: `test-results/step7/${project}-${slug}.png`, fullPage: true });
}

let db: Db | null = null;

function database(): Db {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is needed (scripts/e2e-1b.sh / e2e-1c.sh)');
  db ??= createDb(DATABASE_URL, { max: 1 });
  return db;
}

/** «1 920 ₽» as the page prints it (a narrow no-break space before the sign and in thousands). */
function rub(text: string): RegExp {
  return new RegExp(`^${text.replace(/ /gu, '\\s')}$`, 'u');
}

/** A month of 2024–2025 without any journal event: nothing but this spec writes into it. */
async function freeMonth(): Promise<MonthKey> {
  const start = randomInt(0, 24);
  for (let i = 0; i < 24; i += 1) {
    const month = addMonths('2024-01', (start + i) % 24);
    const bounds = monthBounds(month);
    const [row] = await database()
      .select({ count: sql<number>`count(*)::int` })
      .from(orderEvents)
      .where(and(gte(orderEvents.createdAt, bounds.start), lt(orderEvents.createdAt, bounds.end)));
    if (Number(row?.count ?? 0) === 0) return month;
  }
  throw new Error('no free month in 2024–2025');
}

interface Seeded {
  orderId: string;
  number: string;
  itemIds: string[];
  userId: string;
}

const seeded: Seeded[] = [];

async function seedOrder(input: {
  scheme?: PaymentScheme;
  status: OrderStatus;
  itemState: OrderItemState;
  lines: { brand: string; article: string; name: string; clientKop: number; supplierKop: number }[];
  receivedAt?: Date | null;
  handedAt?: Date | null;
  deadline?: Date | null;
}): Promise<Seeded> {
  const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  const [user] = await database().insert(users).values({ phone }).returning({ id: users.id });
  const total = input.lines.reduce((sum, line) => sum + line.clientKop, 0);
  const [order] = await database()
    .insert(orders)
    .values({
      userId: user!.id,
      accessToken: randomBytes(32).toString('base64url'),
      status: input.status,
      paymentScheme: input.scheme ?? 'prepay',
      subtotalKop: total,
      totalKop: total,
      itemsHash: 'e2e-month',
      receivedAt: input.receivedAt ?? null,
      handedAt: input.handedAt ?? null,
      supplierReturnDeadlineAt: input.deadline ?? null,
    })
    .returning({ id: orders.id, number: orders.number });
  const itemIds: string[] = [];
  for (const line of input.lines) {
    const articleNorm = line.article.replace(/[^A-Z0-9]/giu, '').toUpperCase();
    const [item] = await database()
      .insert(orderItems)
      .values({
        orderId: order!.id,
        offerKey: `${articleNorm}:${line.brand}:ORB1`,
        searchArticleNorm: articleNorm,
        brand: line.brand,
        article: line.article,
        name: line.name,
        qty: 1,
        stockId: 'ORB1',
        isLocal: true,
        priceSupplierAtOrderKop: line.supplierKop,
        priceClientKop: line.clientKop,
        markupBp: 2800,
        offerSnapshot: {
          source: 'rossko',
          brand: line.brand,
          article: line.article,
          articleNorm,
          name: line.name,
          group: null,
          isCross: false,
          priceSupplierKop: line.supplierKop,
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
        },
        state: input.itemState,
      })
      .returning({ id: orderItems.id });
    itemIds.push(item!.id);
  }
  const out = { orderId: order!.id, number: order!.number, itemIds, userId: user!.id };
  seeded.push(out);
  return out;
}

async function journal(
  orderId: string,
  type: string,
  at: Date,
  extra: { toStatus?: OrderStatus; payload?: Record<string, unknown> } = {},
): Promise<void> {
  await database()
    .insert(orderEvents)
    .values({
      orderId,
      type,
      toStatus: extra.toStatus ?? null,
      actorType: 'system',
      actorId: 'e2e',
      payload: extra.payload ?? {},
      createdAt: at,
    });
}

/** A succeeded payment with its receipt (and the journal event of the receipt). */
async function paid(
  order: Seeded,
  input: { kind: 'prepayment' | 'full'; amountKop: number; at: Date },
): Promise<string> {
  const [payment] = await database()
    .insert(payments)
    .values({
      orderId: order.orderId,
      providerPaymentId: `e2e-month-${randomUUID()}`,
      kind: input.kind,
      status: 'succeeded',
      amountKop: input.amountKop,
      idempotenceKey: randomUUID(),
      paidAt: input.at,
      createdAt: input.at,
    })
    .returning({ id: payments.id });
  const [receipt] = await database()
    .insert(receipts)
    .values({
      orderId: order.orderId,
      paymentId: payment!.id,
      kind: input.kind,
      idempotenceKey: randomUUID(),
      status: 'succeeded',
    })
    .returning({ id: receipts.id });
  await journal(order.orderId, 'receipt_succeeded', new Date(input.at.getTime() + 60_000), {
    payload: { receiptId: receipt!.id },
  });
  return payment!.id;
}

async function cleanup(month: MonthKey | null): Promise<void> {
  const orderIds = seeded.map((order) => order.orderId);
  const itemIds = seeded.flatMap((order) => order.itemIds);
  const userIds = seeded.map((order) => order.userId);
  seeded.length = 0;
  const d = database();
  if (itemIds.length > 0) {
    await d.delete(stockItems).where(inArray(stockItems.orderItemId, itemIds));
    await d.delete(supplierReturns).where(inArray(supplierReturns.orderItemId, itemIds));
  }
  if (orderIds.length > 0) {
    await d.delete(orderEvents).where(inArray(orderEvents.orderId, orderIds));
    await d.delete(receipts).where(inArray(receipts.orderId, orderIds));
    await d.delete(payments).where(inArray(payments.orderId, orderIds));
    await d.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
    await d.delete(orders).where(inArray(orders.id, orderIds));
  }
  if (userIds.length > 0) await d.delete(users).where(inArray(users.id, userIds));
  if (month) await d.delete(financeReconciliations).where(eq(financeReconciliations.month, month));
  await d
    .update(settings)
    .set({ value: DEFAULT_CONTRACT_RATES, updatedBy: 'seed', updatedAt: new Date() })
    .where(eq(settings.key, CONTRACT_RATES_KEY));
}

/** A UTC instant `day` days after the start of the month at 06:00 Orenburg + hours. */
function dayOf(month: MonthKey, day: number, hour = 0): Date {
  return new Date(
    monthBounds(month).start.getTime() + (day - 1) * 86_400_000 + (6 + hour) * 3_600_000,
  );
}

test.describe('the month close', () => {
  test.skip(
    !ADMIN_USER || !DATABASE_URL,
    'needs the admin and the database: bash scripts/e2e-1b.sh',
  );
  test.use({ httpCredentials: { username: ADMIN_USER ?? 'admin', password: ADMIN_PASSWORD } });

  let month: MonthKey | null = null;

  test.afterEach(async () => {
    if (DATABASE_URL) await cleanup(month);
    month = null;
  });

  test.afterAll(async () => {
    await db?.close();
    db = null;
  });

  test('revenue, margin, act, reconciliation, rates, the printed act and the CSV', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
    const project = testInfo.project.name;
    month = await freeMonth();
    const title = monthTitle(month);

    // --- the month: a prepay order (2 parts) and a pay-at-the-point order sold below cost ------
    const prepay = await seedOrder({
      status: 'handed',
      itemState: 'handed',
      receivedAt: dayOf(month, 11),
      handedAt: dayOf(month, 12),
      lines: [
        {
          brand: 'MANN',
          article: 'W 914/2',
          name: 'Фильтр масляный',
          clientKop: 128_000,
          supplierKop: 100_000,
        },
        {
          brand: 'BOSCH',
          article: 'F 026',
          name: 'Фильтр воздушный',
          clientKop: 64_000,
          supplierKop: 50_000,
        },
      ],
    });
    const prepayPayment = await paid(prepay, {
      kind: 'prepayment',
      amountKop: 192_000,
      at: dayOf(month, 10),
    });
    const [offset] = await database()
      .insert(receipts)
      .values({
        orderId: prepay.orderId,
        paymentId: prepayPayment,
        kind: 'offset',
        idempotenceKey: randomUUID(),
        status: 'succeeded',
        request: { prepaymentKop: 192_000 },
      })
      .returning({ id: receipts.id });
    await journal(prepay.orderId, 'receipt_succeeded', dayOf(month, 12, 1), {
      payload: { receiptId: offset!.id },
    });
    await journal(prepay.orderId, 'item_arrived', dayOf(month, 11), {
      payload: { itemId: prepay.itemIds[0] },
    });
    await journal(prepay.orderId, 'item_arrived', dayOf(month, 11, 1), {
      payload: { itemId: prepay.itemIds[1] },
    });
    await journal(prepay.orderId, 'handed_over', dayOf(month, 12), { toStatus: 'handed' });

    const cheap = await seedOrder({
      scheme: 'pay_on_handover',
      status: 'handed',
      itemState: 'handed',
      receivedAt: dayOf(month, 18),
      handedAt: dayOf(month, 20),
      lines: [
        {
          brand: 'NGK',
          article: 'BKR6E',
          name: 'Свеча зажигания',
          clientKop: 40_000,
          supplierKop: 45_000,
        },
      ],
    });
    await paid(cheap, { kind: 'full', amountKop: 40_000, at: dayOf(month, 20) });
    await journal(cheap.orderId, 'item_arrived', dayOf(month, 18), {
      payload: { itemId: cheap.itemIds[0] },
    });
    await journal(cheap.orderId, 'handed_over', dayOf(month, 20), { toStatus: 'handed' });

    // Rossko paid back 500 ₽ for a returned part on the 25th.
    const returned = await seedOrder({
      status: 'cancelled',
      itemState: 'refunded',
      lines: [
        {
          brand: 'BOSCH',
          article: 'F 026',
          name: 'Фильтр воздушный',
          clientKop: 64_000,
          supplierKop: 50_000,
        },
      ],
    });
    await database()
      .insert(supplierReturns)
      .values({
        orderItemId: returned.itemIds[0]!,
        kind: 'return',
        status: 'refunded',
        amountExpectedKop: 50_000,
        amountReceivedKop: 50_000,
        shippedAt: dayOf(month, 22),
        refundedAt: dayOf(month, 25),
      });

    // --- /admin/month with no rates yet ----------------------------------------------------
    const response = await page.goto(`/admin/month?m=${month}`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['x-robots-tag'] ?? '').toContain('noindex');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Закрытие месяца: ${title}`);
    await expect(page.getByTestId('month-revenue-total')).toHaveText(rub('2 320 ₽'));
    // 1 920 − 1 500 − 53,76 + 400 − 450 − 11,20 = 305,04 ₽ of 2 320 ₽
    await expect(page.getByTestId('month-margin-total')).toHaveText(/^305,04\s₽ \(13,14%\)$/u);
    await expect(page.getByTestId('month-negative')).toContainText(cheap.number);
    await expect(page.getByTestId('month-rates-unset')).toContainText('Ставки не заданы');
    const lines = page.getByTestId('month-act-lines');
    await expect(lines.locator('[data-op="receive"]')).toContainText('3 шт.');
    await expect(lines.locator('[data-op="store_day"]')).toContainText('3 сут.');
    await expect(lines.locator('[data-op="handover"]')).toContainText('2 шт.');
    await expect(page.getByTestId('month-act-total')).toHaveText(rub('0 ₽'));
    await expect(page.getByTestId('month-not-income-rows')).toContainText(returned.number);
    await expect(page.getByTestId('month-not-income-rows')).toContainText('500');
    await expect(page.getByTestId('month-recon-none')).toBeVisible();
    await expectNoHorizontalScroll(page, '/admin/month');
    await shot(page, project, 'month-no-rates');

    // --- «Сверить»: the month's payments are only in our database ----------------------------
    await page.getByTestId('month-reconcile').click();
    await expect(page).toHaveURL(new RegExp(`/admin/month\\?m=${month}&done=`, 'u'));
    await expect(page.getByTestId('admin-done')).toHaveText(
      `Сверка за ${title} сохранена: расхождений 2`,
    );
    const diffs = page.getByTestId('month-recon-diffs');
    await expect(diffs.locator('tbody tr')).toHaveCount(2);
    await expect(diffs).toContainText('Есть в базе, нет в ЮKassa');
    await expect(diffs).toContainText(prepay.number);
    await expectNoHorizontalScroll(page, '/admin/month after «Сверить»');

    // --- the rates: draft, preview, save ------------------------------------------------------
    await page.getByRole('link', { name: 'Изменить ставки' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/month/rates\\?m=${month}$`, 'u'));
    await page.locator('#rate_receive').fill('50');
    await page.locator('#rate_store_day').fill('10');
    await page.locator('#rate_handover').fill('100');
    await page.locator('#rate_return_accept').fill('150');
    await page.locator('#rate_vin_selection').fill('200');
    await page.locator('#rate_fit_check').fill('75');
    await page.locator('#rate_claim_diagnostics').fill('300');
    await page.locator('#turnover').fill('1');
    await page.getByRole('button', { name: 'Показать акт с этими ставками' }).click();
    await expect(page).toHaveURL(/draft=1/u);
    // 3 × 50 + 3 × 10 + 2 × 100 + 1% of 2 320 ₽ = 403,20 ₽
    await expect(page.getByTestId('rates-total-now')).toHaveText(rub('0 ₽'));
    await expect(page.getByTestId('rates-total-draft')).toHaveText(rub('403,20 ₽'));
    await expectNoHorizontalScroll(page, '/admin/month/rates preview');
    await shot(page, project, 'rates-preview');
    await page.getByTestId('rates-save').getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Сохранить ставки' }).click();
    await expect(page.getByTestId('admin-done')).toHaveText(
      /^Ставки сохранены\. Акт за .+: 403,20\s₽$/u,
    );

    // --- the month with the rates (every section) ---------------------------------------------
    await page.goto(`/admin/month?m=${month}`);
    await expect(page.getByTestId('month-rates-unset')).toHaveCount(0);
    await expect(page.getByTestId('month-act-total')).toHaveText(rub('403,20 ₽'));
    for (const id of [
      'month-revenue',
      'month-margin',
      'month-act',
      'month-recon',
      'month-not-income',
      'month-rates',
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expectNoHorizontalScroll(page, '/admin/month with the rates');
    await shot(page, project, 'month');

    // --- the printed act -----------------------------------------------------------------------
    await page.getByTestId('month-act-print').click();
    await expect(page).toHaveURL(new RegExp(`/admin/month/act\\?m=${month}$`, 'u'));
    const act = page.getByTestId('act-print');
    await expect(page.getByTestId('act-title')).toHaveText(
      new RegExp(
        `^Акт № ${month.slice(5)}/${month.slice(0, 4)} от \\d{1,2} \\S+ ${month.slice(0, 4)} г\\.$`,
        'u',
      ),
    );
    await expect(page.getByTestId('act-total')).toHaveText(rub('403,20'));
    await expect(act.locator('tbody tr')).toHaveCount(8);
    await expect(page.getByTestId('act-parties')).toContainText('Заказчик: ИП ');
    expect(await act.innerText()).not.toMatch(FORBIDDEN);
    await expectNoHorizontalScroll(page, '/admin/month/act');
    await shot(page, project, 'act');
    // On paper: only the act, no admin chrome and no screen warnings.
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByTestId('admin-nav')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Печать' })).toBeHidden();
    await expect(act).toBeVisible();
    await shot(page, project, 'act-print');
    await page.emulateMedia({ media: 'screen' });

    // --- «Скачать CSV» ---------------------------------------------------------------------------
    const csv = await request.get(`/api/admin/month/csv?m=${month}`);
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toBe('text/csv; charset=utf-8');
    const rows = new TextDecoder()
      .decode(await csv.body())
      .trimEnd()
      .split('\r\n');
    expect(rows[0]).toBe('Дата;Заказ;Операция;Ставка, ₽');
    // 3 arrivals, 3 storage days, 2 handovers.
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => row.includes(';Выдача заказа покупателю;100,00'))).toHaveLength(2);
  });

  test('supplier returns: «Сдал водителю», «Не берут», «Деньги вернулись», «Списать»', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const project = testInfo.project.name;
    const now = Date.now();
    const order = await seedOrder({
      status: 'cancelled',
      itemState: 'refund_pending',
      deadline: new Date(now - 86_400_000),
      lines: [
        {
          brand: 'MANN',
          article: 'W 914/2',
          name: 'Фильтр масляный',
          clientKop: 128_000,
          supplierKop: 100_000,
        },
        {
          brand: 'BOSCH',
          article: 'F 026',
          name: 'Фильтр воздушный',
          clientKop: 64_000,
          supplierKop: 50_000,
        },
      ],
    });
    const waiting = await seedOrder({
      status: 'cancelled',
      itemState: 'refund_pending',
      deadline: new Date(now - 14 * 86_400_000),
      lines: [
        {
          brand: 'NGK',
          article: 'BKR6E',
          name: 'Свеча зажигания',
          clientKop: 40_000,
          supplierKop: 30_000,
        },
      ],
    });
    await database()
      .insert(supplierReturns)
      .values([
        ...order.itemIds.map((orderItemId, i) => ({
          orderItemId,
          kind: 'return' as const,
          status: 'requested' as const,
          amountExpectedKop: i === 0 ? 100_000 : 50_000,
        })),
        {
          orderItemId: waiting.itemIds[0]!,
          kind: 'return' as const,
          status: 'shipped' as const,
          amountExpectedKop: 30_000,
          shippedAt: new Date(now - 12 * 86_400_000),
        },
      ]);

    const response = await page.goto('/admin/returns');
    expect(response?.status()).toBe(200);
    const mine = page.getByTestId('return-row').filter({ hasText: order.number });
    await expect(mine).toHaveCount(2);
    await expect(
      page
        .getByTestId('returns-overdue')
        .getByTestId('return-row')
        .filter({ hasText: order.number }),
    ).toHaveCount(2);
    await expect(
      page
        .getByTestId('returns-waiting_money')
        .getByTestId('return-row')
        .filter({ hasText: waiting.number }),
    ).toContainText('ждём деньги 12 дн.');
    await expectNoHorizontalScroll(page, '/admin/returns');
    await shot(page, project, 'returns');

    const mann = () =>
      page.getByTestId('return-row').filter({ hasText: order.number }).filter({ hasText: 'MANN' });
    const bosch = () =>
      page.getByTestId('return-row').filter({ hasText: order.number }).filter({ hasText: 'BOSCH' });
    await mann().getByRole('button', { name: 'Сдал водителю' }).click();
    await expect(page.getByTestId('admin-done')).toHaveText(
      'Сдано водителю: MANN W 914/2. Ждём деньги от Rossko',
    );
    await expect(mann()).toHaveAttribute('data-status', 'shipped');
    await bosch().getByRole('button', { name: 'Не берут' }).click();
    await expect(page.getByTestId('admin-done')).toHaveText(
      /^Не берут: BOSCH F 026 — деталь на складе \(500\s₽\)$/u,
    );
    await mann().getByRole('textbox').fill('1000');
    await mann().getByRole('button', { name: 'Деньги вернулись' }).click();
    await expect(page.getByTestId('admin-done')).toHaveText(
      /^Деньги вернулись: MANN W 914\/2, 1\s000\s₽$/u,
    );
    await expect(mann()).toHaveAttribute('data-status', 'refunded');
    await expectNoHorizontalScroll(page, '/admin/returns after the actions');

    // --- the stock -----------------------------------------------------------------------------
    await page.goto('/admin/stock');
    const row = page.getByTestId('stock-row').filter({ hasText: order.number });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Не принят поставщиком');
    await expect(row).toContainText('500');
    await expectNoHorizontalScroll(page, '/admin/stock');
    await shot(page, project, 'stock');
    await row.getByRole('checkbox').check();
    await row.getByRole('button', { name: 'Списать' }).click();
    await expect(page.getByTestId('admin-done')).toHaveText(/^Списано: BOSCH F 026/u);
    await expect(page.getByTestId('stock-row').filter({ hasText: order.number })).toHaveAttribute(
      'data-written-off',
      'true',
    );
  });
});
