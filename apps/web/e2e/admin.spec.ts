/**
 * Phase 1B mini admin end to end (docs/phase-1b-implementation.md sections 15 and 16.4) on
 * mobile 375x812 and desktop 1280x800, with the worker running the queues:
 *
 *   client: cart (Knecht OC 90 × 2 and TRW GDB1330 from the Orenburg stock, the lines of the
 *   GetCheckout.ok fixture) -> order (pay on handover) -> «Подтверждаю»;
 *   admin: card -> «Проверить и заказать» (worker: recheck + GetCheckout) -> «Приехало» × 2 ->
 *   «Клиент пришёл» -> «Выставить оплату» (worker: QR payment at the mock) -> the client pays
 *   the QR -> «Выдал» once the receipt is registered -> «Выдан» (also on /o/<token>).
 *
 * Basic auth: E2E_ADMIN_USER / E2E_ADMIN_PASSWORD (scripts/e2e-1b.sh derives them from
 * ADMIN_BASIC_AUTH). Screenshots: test-results/screens/<project>-admin-*.png.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, randomIp, screenshot } from './helpers';
import {
  addToCart,
  checkOutCart,
  KNECHT_LOCAL,
  newClient,
  PAYMENTS_ON,
  setCartQty,
  TRW_LOCAL,
} from './shop';

const MOCK_URL = process.env.E2E_YOOKASSA_MOCK_URL ?? 'http://127.0.0.1:3199';
const ADMIN_USER = process.env.E2E_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'e2e-admin-password';
/** The worker answers within seconds; the queues retry with backoff on a hiccup. */
const WORKER_MS = 45_000;

test.skip(!PAYMENTS_ON, 'needs the worker and the YooKassa mock: bash scripts/e2e-1b.sh');

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
  httpCredentials: { username: ADMIN_USER, password: ADMIN_PASSWORD },
});

function adminStatus(page: Page) {
  return page.getByTestId('admin-status');
}

/** Reloads the card until its status (data-status) is `status` (the worker acts in between). */
async function waitForAdminStatus(page: Page, status: string): Promise<void> {
  await expect(async () => {
    await page.reload();
    await expect(adminStatus(page)).toHaveAttribute('data-status', status, { timeout: 1_000 });
  }).toPass({ timeout: WORKER_MS, intervals: [500, 1_000, 2_000] });
}

/** Submits one action form of the card; the handler answers 303 back to the card. */
async function act(page: Page, code: string, itemId?: string): Promise<void> {
  const selector = itemId
    ? `form[data-action="${code}"][data-item="${itemId}"]`
    : `form[data-action="${code}"]`;
  const form = page.locator(selector);
  await expect(form).toHaveCount(1);
  const button = form.getByRole('button');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page).toHaveURL(/\/admin\/orders\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('admin-done')).toBeVisible();
}

interface MockPayment {
  id: string;
  status: string;
  metadata?: Record<string, string>;
  confirmation?: { type?: string; confirmation_data?: string };
}

/** The pending QR payment of the order at the YooKassa mock (what the seller's screen shows). */
async function pendingQr(request: APIRequestContext, number: string): Promise<MockPayment> {
  let found: MockPayment | undefined;
  await expect(async () => {
    const answer = await request.get(`${MOCK_URL}/__mock/payments`);
    const { items } = (await answer.json()) as { items: MockPayment[] };
    found = items.find(
      (p) =>
        p.metadata?.order_number === number &&
        p.confirmation?.type === 'qr' &&
        p.status === 'pending',
    );
    expect(found, `pending QR payment of ${number}`).toBeTruthy();
  }).toPass({ timeout: WORKER_MS });
  return found as MockPayment;
}

test('admin: an order from «Проверить и заказать» to «Выдан»', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const project = testInfo.project.name;

  // --- the client: a pay-on-handover order, confirmed on /o/<token> -------------------------
  const client = newClient();
  await addToCart(page, 'OC90', KNECHT_LOCAL);
  await setCartQty(page, 'Knecht', 2);
  await addToCart(page, 'GDB1330', TRW_LOCAL);
  await expect(page.getByTestId('cart-line')).toHaveCount(2);
  const { token, number } = await checkOutCart(page, client, 'pay_on_handover');
  await expect(page.getByTestId('order-status')).toHaveText('Ждёт подтверждения');
  await page.getByTestId('order-confirm-open').click();
  await page.getByTestId('order-confirm-submit').click();
  await expect(page.getByTestId('order-status')).toHaveText('Подтверждён');

  // --- the admin: list -> card -----------------------------------------------------------
  const list = await page.goto(`/admin?q=${number}`);
  expect(list?.status()).toBe(200);
  expect(list?.headers()['x-robots-tag'] ?? '').toContain('noindex');
  const row = page.locator(`tr[data-order="${number}"]`);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(/подтверждён/i);
  await expectNoHorizontalScroll(page, '/admin');
  await screenshot(page, project, 'admin-list');
  await row.getByRole('link', { name: number }).click();
  await expect(page).toHaveURL(/\/admin\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('admin-order')).toContainText(number);
  // The only page with the full phone (decision Б25: under Basic auth).
  await expect(page.getByTestId('admin-client-phone')).toContainText(
    client.phone.national.slice(-4),
  );
  await expectNoHorizontalScroll(page, '/admin/orders/<id> confirmed');
  await screenshot(page, project, 'admin-card-confirmed');

  // «Проверить и заказать»: the worker rechecks the prices and places the Rossko order.
  await act(page, 'recheck');
  await waitForAdminStatus(page, 'ordered_at_supplier');

  // «Приехало» for both items.
  const arrive = page.locator('form[data-action="iarr"]');
  await expect(arrive).toHaveCount(2);
  const itemIds = await arrive.evaluateAll((forms) =>
    forms.map((f) => f.getAttribute('data-item') ?? ''),
  );
  for (const itemId of itemIds) await act(page, 'iarr', itemId);
  await expect(adminStatus(page)).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('admin-item-state')).toHaveText(['приехала', 'приехала']);
  await screenshot(page, project, 'admin-card-ready');

  // «Выдал» needs the money first; «Выставить оплату» needs «Клиент пришёл».
  await expect(page.locator('form[data-action="qr"]')).toHaveCount(0);
  await act(page, 'came');
  await act(page, 'qr');
  await expect(adminStatus(page)).toHaveAttribute('data-status', 'awaiting_handover_payment');

  // The worker creates the QR payment; the card shows the code to the client.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('admin-qr')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: WORKER_MS });
  await expect(page.getByTestId('admin-qr').getByRole('img')).toBeVisible();
  await expectNoHorizontalScroll(page, '/admin/orders/<id> QR');
  await screenshot(page, project, 'admin-card-qr');

  // The client scans the code and pays (the mock notifies web like YooKassa would).
  const qr = await pendingQr(page.request, number);
  const paid = await page.request.get(qr.confirmation?.confirmation_data ?? '');
  expect(paid.status()).toBe(200);

  // «Выдал» becomes available once the payment and its full receipt are confirmed.
  await expect(async () => {
    await page.reload();
    await expect(page.locator('form[data-action="handed"]').getByRole('button')).toBeEnabled({
      timeout: 1_000,
    });
  }).toPass({ timeout: WORKER_MS });
  await act(page, 'handed');
  await expect(adminStatus(page)).toHaveAttribute('data-status', 'handed');
  await expectNoHorizontalScroll(page, '/admin/orders/<id> handed');
  await screenshot(page, project, 'admin-card-handed');

  // The client sees the same.
  await page.goto(`/o/${token}`);
  await expect(page.getByTestId('order-status')).toHaveText('Выдан');
  await expectNoHorizontalScroll(page, '/o/<token> handed');
  await screenshot(page, project, 'admin-client-handed');
});

test('admin without credentials: 401 with a Basic challenge', async ({ baseURL }) => {
  // Plain fetch: every Playwright context of this file carries the admin credentials. Its own
  // ip: the wrong password counts against the admin limit of that bucket (20/h).
  const url = new URL('/admin', baseURL).toString();
  const headers = { 'X-Real-IP': randomIp() };
  const anonymous = await fetch(url, { headers, redirect: 'manual' });
  expect(anonymous.status).toBe(401);
  expect(anonymous.headers.get('www-authenticate') ?? '').toContain('Basic');
  const wrong = await fetch(url, {
    headers: {
      ...headers,
      Authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}`,
    },
    redirect: 'manual',
  });
  expect(wrong.status).toBe(401);
  expect(await wrong.text()).not.toContain('DT-');
});
