/**
 * Step 8 end to end (docs/rossko-automation.md) on mobile 375x812 and desktop 1280x800.
 *
 *   /admin/auto-order: shadow decisions of «Проверить и заказать» seeded straight into the
 *   journal (`auto_order_shadow`: 32 of the last 30 days, 10 more of the 90 days, one «НЕТ»
 *   followed by «Заказать всё равно»). Other specs press «Проверить и заказать» for real, so the
 *   figures are checked as the increase over what the page showed before the seeding; the verdict
 *   must be the one of autoOrderVerdict for the figures on the page. No switch on the page.
 *   /admin/rossko: the codes the GetOrders polling has seen (journal `rossko_status`, seeded) in
 *   the map editor, the warning «ROSSKO_MODE=fixtures», saving the map (two seen codes and a new
 *   one typed in), the polling switch, the order deadline, the cutoff times and the shadow limit —
 *   every form through the audited writer (settings_audit), «Без изменений» on a repeat, 409 on a
 *   stale version.
 *
 * Everything seeded is removed and the five settings are back at their defaults after the test.
 * Needs the admin and the database: scripts/e2e-1b.sh and scripts/e2e-1c.sh.
 * Screenshots for a human look: test-results/step8/<project>-*.png.
 */
import { randomBytes, randomInt } from 'node:crypto';
import {
  and,
  createDb,
  eq,
  gte,
  inArray,
  orderEvents,
  orders,
  settings,
  settingsAudit,
  users,
  type Db,
} from '@detaly/db';
import {
  AUTO_ORDER_MAX_TOTAL_KEY,
  AUTO_ORDER_REASONS,
  autoOrderVerdict,
  DEFAULT_ROSSKO_AUTOMATION_SETTINGS,
  ROSSKO_CUTOFF_TIMES_KEY,
  ROSSKO_ORDER_WITHIN_KEY,
  ROSSKO_POLL_ENABLED_KEY,
  ROSSKO_STATUS_MAP_KEY,
  type AutoOrderReason,
} from '@detaly/domain';
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, randomIp } from './helpers';

const ADMIN_USER = process.env.E2E_ADMIN_USER;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const DATABASE_URL = process.env.DATABASE_URL ?? null;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_TOTAL_KOP = 1_500_000;

const DEFAULTS: Record<string, unknown> = {
  [ROSSKO_STATUS_MAP_KEY]: DEFAULT_ROSSKO_AUTOMATION_SETTINGS.statusMap,
  [ROSSKO_POLL_ENABLED_KEY]: DEFAULT_ROSSKO_AUTOMATION_SETTINGS.pollEnabled,
  [ROSSKO_ORDER_WITHIN_KEY]: DEFAULT_ROSSKO_AUTOMATION_SETTINGS.orderWithinMinutes,
  [AUTO_ORDER_MAX_TOTAL_KEY]: DEFAULT_ROSSKO_AUTOMATION_SETTINGS.autoOrderMaxTotalKop,
  [ROSSKO_CUTOFF_TIMES_KEY]: DEFAULT_ROSSKO_AUTOMATION_SETTINGS.cutoffTimes,
};

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
});

async function shot(page: Page, project: string, slug: string): Promise<void> {
  await page.screenshot({ path: `test-results/step8/${project}-${slug}.png`, fullPage: true });
}

let db: Db | null = null;

function database(): Db {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is needed (scripts/e2e-1b.sh / e2e-1c.sh)');
  db ??= createDb(DATABASE_URL, { max: 1 });
  return db;
}

/** «15 000 ₽» as the page prints it (no-break spaces). */
function rub(text: string): string {
  return text.replace(/ /gu, '\\s');
}

const seededOrders: string[] = [];
const seededUsers: string[] = [];

/** A cancelled order (no worker job looks at it) to hang journal events on. */
async function seedOrder(userId: string): Promise<{ id: string; number: string }> {
  const [order] = await database()
    .insert(orders)
    .values({
      userId,
      accessToken: randomBytes(32).toString('base64url'),
      status: 'cancelled',
      paymentScheme: 'prepay',
      subtotalKop: 192_000,
      totalKop: 192_000,
      itemsHash: 'e2e-rossko-automation',
    })
    .returning({ id: orders.id, number: orders.number });
  seededOrders.push(order!.id);
  return order!;
}

async function journal(
  orderId: string,
  type: string,
  at: Date,
  payload: Record<string, unknown>,
): Promise<void> {
  await database()
    .insert(orderEvents)
    .values({ orderId, type, actorType: 'system', actorId: 'e2e', payload, createdAt: at });
}

interface ShadowSeed {
  decision: 'yes' | 'no';
  reasons: AutoOrderReason[];
  masterOrdered: boolean;
  ageMs: number;
  /** «Заказать всё равно» 10 minutes after the decision. */
  anyway?: boolean;
}

/** One order per decision: the journal as the rossko/recheck job writes it. */
async function seedShadow(userId: string, seed: ShadowSeed): Promise<string> {
  const order = await seedOrder(userId);
  const at = new Date(Date.now() - seed.ageMs);
  await journal(order.id, 'auto_order_shadow', at, {
    decision: seed.decision,
    reasons: seed.reasons,
    masterOrdered: seed.masterOrdered,
    outcome: seed.masterOrdered ? 'ordering' : 'needs_attention',
    totalKop: 192_000,
    maxTotalKop: MAX_TOTAL_KOP,
    marginBp: 2_187,
  });
  if (seed.anyway) {
    await journal(order.id, 'order_anyway', new Date(at.getTime() + 10 * 60_000), {});
  }
  return order.number;
}

async function cleanup(): Promise<void> {
  const d = database();
  const orderIds = seededOrders.splice(0);
  const userIds = seededUsers.splice(0);
  if (orderIds.length > 0) {
    await d.delete(orderEvents).where(inArray(orderEvents.orderId, orderIds));
    await d.delete(orders).where(inArray(orders.id, orderIds));
  }
  if (userIds.length > 0) await d.delete(users).where(inArray(users.id, userIds));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await d
      .update(settings)
      .set({ value, updatedBy: 'seed', updatedAt: new Date() })
      .where(eq(settings.key, key));
  }
}

interface PageStats {
  decisions: number;
  yes: number;
  no: number;
  agreements: number;
  reasons: Record<AutoOrderReason, number>;
}

/** The figures of one period block of /admin/auto-order. */
async function readStats(page: Page, days: 30 | 90): Promise<PageStats> {
  const decisions = /^(\d+) \(ДА (\d+), НЕТ (\d+)\)$/u.exec(
    (await page.getByTestId(`auto-order-decisions-${days}`).innerText()).trim(),
  );
  expect(decisions, `decisions of ${days} days`).not.toBeNull();
  const agreementsText = (
    await page.getByTestId(`auto-order-agreements-${days}`).innerText()
  ).trim();
  const agreements = agreementsText === '—' ? 0 : Number(/\((\d+)\)$/u.exec(agreementsText)?.[1]);
  expect(Number.isInteger(agreements), `agreements of ${days} days: ${agreementsText}`).toBe(true);
  const reasons = {} as Record<AutoOrderReason, number>;
  for (const reason of AUTO_ORDER_REASONS) {
    reasons[reason] = Number(
      (await page.getByTestId(`auto-order-reason-${reason}-${days}`).innerText()).trim(),
    );
  }
  return {
    decisions: Number(decisions![1]),
    yes: Number(decisions![2]),
    no: Number(decisions![3]),
    agreements,
    reasons,
  };
}

function plus(
  before: PageStats,
  delta: Omit<PageStats, 'reasons'> & { reasons: Partial<Record<AutoOrderReason, number>> },
): PageStats {
  const reasons = { ...before.reasons };
  for (const reason of AUTO_ORDER_REASONS) reasons[reason] += delta.reasons[reason] ?? 0;
  return {
    decisions: before.decisions + delta.decisions,
    yes: before.yes + delta.yes,
    no: before.no + delta.no,
    agreements: before.agreements + delta.agreements,
    reasons,
  };
}

async function expectVerdict(page: Page, days: 30 | 90, stats: PageStats): Promise<void> {
  const verdict = autoOrderVerdict(stats);
  const block = page.getByTestId(`auto-order-verdict-${days}`);
  await expect(block).toHaveText(verdict.text);
  await expect(block).toHaveAttribute('data-kind', verdict.kind);
}

/** Submits a form of /admin/rossko and waits for the 303 back with its message. */
async function submit(page: Page, button: string, done: RegExp | string): Promise<void> {
  await page.getByTestId(button).click();
  await expect(page).toHaveURL(/\/admin\/rossko\?done=/u);
  await expect(page.getByTestId('admin-done')).toHaveText(done);
}

async function storedSetting(key: string): Promise<unknown> {
  const [row] = await database()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key));
  return row?.value;
}

test.describe('Rossko without the manual cabinet', () => {
  test.skip(
    !ADMIN_USER || !DATABASE_URL,
    'needs the admin and the database: bash scripts/e2e-1b.sh',
  );
  test.use({ httpCredentials: { username: ADMIN_USER ?? 'admin', password: ADMIN_PASSWORD } });

  test.afterEach(async () => {
    if (DATABASE_URL) await cleanup();
  });

  test.afterAll(async () => {
    await db?.close();
    db = null;
  });

  test('the shadow auto-order statistics and the Rossko settings', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    test.setTimeout(120_000);
    const project = testInfo.project.name;
    const startedAt = new Date();
    const phone = `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
    const [user] = await database().insert(users).values({ phone }).returning({ id: users.id });
    seededUsers.push(user!.id);

    // --- /admin/auto-order before the seeding ------------------------------------------------
    let response = await page.goto('/admin/auto-order');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['x-robots-tag'] ?? '').toContain('noindex');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Теневой автозаказ');
    const before30 = await readStats(page, 30);
    const before90 = await readStats(page, 90);

    // --- 32 decisions of the last 30 days: 31 the same as the master -------------------------
    // 25 × «ДА» and the master ordered.
    for (let i = 0; i < 25; i += 1) {
      await seedShadow(user!.id, {
        decision: 'yes',
        reasons: [],
        masterOrdered: true,
        ageMs: 3 * HOUR_MS + i * 20 * HOUR_MS,
      });
    }
    // 6 × «НЕТ» and the master did not order either (the newest of them with two reasons).
    const noReasons: AutoOrderReason[][] = [
      ['vin_selection'],
      ['fit_unconfirmed'],
      ['no_show'],
      ['unavailable'],
      ['margin_floor', 'price_drift'],
    ];
    for (const [i, reasons] of noReasons.entries()) {
      await seedShadow(user!.id, {
        decision: 'no',
        reasons,
        masterOrdered: false,
        ageMs: 2 * DAY_MS + i * DAY_MS,
      });
    }
    const driftAndTotal = await seedShadow(user!.id, {
      decision: 'no',
      reasons: ['price_drift', 'total_over_limit'],
      masterOrdered: false,
      ageMs: HOUR_MS,
    });
    // «НЕТ», then «Заказать всё равно»: the master ordered after all.
    const orderedAnyway = await seedShadow(user!.id, {
      decision: 'no',
      reasons: ['total_over_limit'],
      masterOrdered: false,
      ageMs: 2 * HOUR_MS,
      anyway: true,
    });
    // --- 10 more of 31–89 days ago: 7 the same as the master ------------------------------------
    const older: Pick<ShadowSeed, 'decision' | 'reasons' | 'masterOrdered'>[] = [
      ...Array.from({ length: 5 }, () => ({
        decision: 'yes' as const,
        reasons: [],
        masterOrdered: true,
      })),
      ...Array.from({ length: 3 }, () => ({
        decision: 'yes' as const,
        reasons: [],
        masterOrdered: false,
      })),
      ...Array.from({ length: 2 }, () => ({
        decision: 'no' as const,
        reasons: ['price_drift' as const],
        masterOrdered: false,
      })),
    ];
    for (const [i, seed] of older.entries()) {
      await seedShadow(user!.id, { ...seed, ageMs: (35 + i * 5) * DAY_MS });
    }

    // --- /admin/auto-order: the increase and the verdict ---------------------------------------
    response = await page.goto('/admin/auto-order');
    expect(response?.status()).toBe(200);
    const after30 = await readStats(page, 30);
    const after90 = await readStats(page, 90);
    expect(after30).toEqual(
      plus(before30, {
        decisions: 32,
        yes: 25,
        no: 7,
        agreements: 31,
        reasons: {
          price_drift: 2,
          total_over_limit: 2,
          vin_selection: 1,
          fit_unconfirmed: 1,
          no_show: 1,
          unavailable: 1,
          margin_floor: 1,
        },
      }),
    );
    expect(after90).toEqual(
      plus(before90, {
        decisions: 42,
        yes: 33,
        no: 9,
        agreements: 38,
        reasons: {
          price_drift: 4,
          total_over_limit: 2,
          vin_selection: 1,
          fit_unconfirmed: 1,
          no_show: 1,
          unavailable: 1,
          margin_floor: 1,
        },
      }),
    );
    await expectVerdict(page, 30, after30);
    await expectVerdict(page, 90, after90);
    await expect(page.getByTestId('auto-order-verdict-30')).toHaveText(
      /^(?:Мало данных: совпадений|Рано: совпадений|Совпадений) \d+ из \d+/u,
    );

    const driftRow = page.getByTestId('auto-order-row').filter({ hasText: driftAndTotal });
    await expect(driftRow).toHaveCount(1);
    await expect(driftRow).toContainText(
      new RegExp(
        `НЕТ — цена у поставщика выросла больше допуска, ${rub('сумма больше 15 000 ₽')}`,
        'u',
      ),
    );
    await expect(driftRow.locator('td').last()).toHaveText('не заказал');
    const anywayRow = page.getByTestId('auto-order-row').filter({ hasText: orderedAnyway });
    await expect(anywayRow.locator('td').last()).toHaveText('заказал');
    // Read-only: nothing to switch the real auto-order on with.
    await expect(
      page.getByTestId('admin-auto-order').locator('form, input, select, button'),
    ).toHaveCount(0);
    await expectNoHorizontalScroll(page, '/admin/auto-order');
    await shot(page, project, 'auto-order');

    // --- /admin/rossko: the codes the polling has seen ------------------------------------------
    const [first, second, third] = seededOrders;
    const seen = (orderId: string, code: number, name: string, ageMs: number) =>
      journal(orderId, 'rossko_status', new Date(Date.now() - ageMs), {
        supplierOrderId: null,
        rosskoOrderId: String(70_000_000 + randomInt(0, 1_000_000)),
        code,
        name,
        previousCode: null,
        action: 'unmapped',
      });
    await seen(first!, 3, 'Отгружен', 5 * HOUR_MS);
    await seen(second!, 3, 'Отгружен', 4 * HOUR_MS);
    await seen(third!, 7, 'Отказ', 3 * HOUR_MS);

    response = await page.goto('/admin/rossko');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['x-robots-tag'] ?? '').toContain('noindex');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rossko без личного кабинета');
    // «Rossko» next to «Возвраты Rossko» in the menu.
    const nav = page.getByTestId('admin-nav');
    await expect(nav.getByRole('link', { name: 'Rossko', exact: true })).toHaveAttribute(
      'href',
      '/admin/rossko',
    );
    await expect(nav.getByRole('link', { name: 'Автозаказ', exact: true })).toHaveAttribute(
      'href',
      '/admin/auto-order',
    );
    await expect(page.getByTestId('rossko-mode-warning')).toContainText('ROSSKO_MODE=fixtures');
    await expect(page.getByTestId('rossko-poll-state')).toContainText('Опрос выключен');
    const row3 = page.locator('[data-testid="rossko-map-row"][data-code="3"]');
    const row7 = page.locator('[data-testid="rossko-map-row"][data-code="7"]');
    await expect(row3).toContainText('Код 3 — Отгружен');
    await expect(page.getByTestId('rossko-count-3')).toHaveText('2');
    await expect(page.getByTestId('rossko-seen-3')).toContainText('встречался 2 раза');
    await expect(row7).toContainText('Код 7 — Отказ');
    await expect(page.getByTestId('rossko-count-7')).toHaveText('1');
    await expect(page.getByTestId('rossko-act-3')).toHaveValue('');
    await expect(page.getByTestId('rossko-cutoffs')).toContainText('Отсечки не заданы');
    await expectNoHorizontalScroll(page, '/admin/rossko');
    await shot(page, project, 'rossko');

    // --- the map: two seen codes and a new one ---------------------------------------------------
    await page.getByTestId('rossko-act-3').selectOption('shipped_to_point');
    await page.getByTestId('rossko-act-7').selectOption('refused');
    await page.getByTestId('rossko-new-code').fill('12');
    await page.getByTestId('rossko-act-new-0').selectOption('in_progress');
    await submit(page, 'rossko-map-save', 'Коды статусов сохранены: 3');
    await expect(page.getByTestId('rossko-act-3')).toHaveValue('shipped_to_point');
    await expect(page.getByTestId('rossko-act-7')).toHaveValue('refused');
    await expect(page.getByTestId('rossko-act-12')).toHaveValue('in_progress');
    await expect(page.getByTestId('rossko-seen-12')).toHaveText('опрос его ещё не видел');
    expect(await storedSetting(ROSSKO_STATUS_MAP_KEY)).toEqual({
      '12': 'in_progress',
      '3': 'shipped_to_point',
      '7': 'refused',
    });

    // --- the polling switch: on, but only with ROSSKO_MODE=live ----------------------------------
    await page.getByTestId('rossko-poll-on').check();
    await submit(
      page,
      'rossko-poll-save',
      'Опрос Rossko включён, но работать начнёт только с ROSSKO_MODE=live (ключи Rossko)',
    );
    await expect(page.getByTestId('rossko-poll-state')).toContainText('Опрос включён');
    await expect(page.getByTestId('rossko-mode-warning')).toBeVisible();
    // The same value again: nothing is written.
    await submit(page, 'rossko-poll-save', 'Без изменений');

    // --- the order deadline, the cutoffs and the shadow limit ------------------------------------
    await page.getByTestId('rossko-within-minutes').fill('90');
    await submit(
      page,
      'rossko-within-save',
      '«Не заказано у поставщика» — после 1 ч 30 мин рабочего времени',
    );
    await page.getByTestId('rossko-cutoffs-times').fill('16:00, 11:00');
    await submit(page, 'rossko-cutoffs-save', 'Отсечки Rossko: 11:00, 16:00');
    await expect(page.getByTestId('rossko-cutoffs')).toContainText('Отсечки: 11:00, 16:00.');
    await page.getByTestId('rossko-max-total-rub').fill('12 000');
    await submit(
      page,
      'rossko-max-total-save',
      new RegExp(`^${rub('Порог теневого автозаказа: 12 000 ₽')}$`, 'u'),
    );
    await expect(page.getByTestId('rossko-max-total-rub')).toHaveValue('12000');
    expect(await storedSetting(ROSSKO_POLL_ENABLED_KEY)).toBe(true);
    expect(await storedSetting(ROSSKO_ORDER_WITHIN_KEY)).toBe(90);
    expect(await storedSetting(ROSSKO_CUTOFF_TIMES_KEY)).toEqual(['11:00', '16:00']);
    expect(await storedSetting(AUTO_ORDER_MAX_TOTAL_KEY)).toBe(1_200_000);
    await expectNoHorizontalScroll(page, '/admin/rossko saved');
    await shot(page, project, 'rossko-saved');

    // Every change is in settings_audit (the repeat «Без изменений» is not).
    const audit = await database()
      .select({ key: settingsAudit.key, changedBy: settingsAudit.changedBy })
      .from(settingsAudit)
      .where(
        and(
          inArray(settingsAudit.key, Object.keys(DEFAULTS)),
          gte(settingsAudit.changedAt, startedAt),
        ),
      );
    expect(audit.map((row) => row.key).sort()).toEqual(Object.keys(DEFAULTS).sort());
    expect(new Set(audit.map((row) => row.changedBy))).toEqual(new Set(['admin']));

    // A stale version (the form opened before someone else saved): 409, nothing written.
    const stale = await request.post('/api/admin/rossko', {
      form: { action: 'within', version: 'none', minutes: '60' },
      headers: { Origin: new URL(baseURL ?? 'http://127.0.0.1:3100').origin },
      maxRedirects: 0,
    });
    expect(stale.status()).toBe(409);
    expect(await storedSetting(ROSSKO_ORDER_WITHIN_KEY)).toBe(90);

    // /admin/auto-order names the new limit.
    await page.goto('/admin/auto-order');
    await expect(page.getByTestId('auto-order-intro')).toContainText(
      new RegExp(rub('Порог суммы — 12 000 ₽'), 'u'),
    );
  });
});
