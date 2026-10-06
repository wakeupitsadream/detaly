/**
 * Phase 1C order page end to end (docs/phase-1c-implementation.md section 10, item 8) on mobile
 * 375x812 and desktop 1280x800, with the worker running the queues:
 *
 *   client: a pay-on-handover order (Knecht OC 90 and TRW GDB1330 from the Orenburg stock) ->
 *   «Подтверждаю» -> «Статусы в Telegram» goes to t.me/<bot>?start=<link token> (never the
 *   order token; the t.me request is answered by a stub, there is no network);
 *   admin: «Проверить и заказать» -> «Приехало» × 2 -> `ready`;
 *   client: «Запись на установку» -> a slot chip -> «Записаться» -> «ждём подтверждения мастера»
 *   (screenshot `order-1c-ready`);
 *   admin: «Клиент пришёл» -> «Выставить оплату» -> the QR is paid at the YooKassa mock ->
 *   «Выдал»;
 *   client: «Претензия или возврат» with a JPEG photo and the last 4 phone digits -> the claim
 *   card with the steps and the memo PDF (screenshot `order-1c-handed`).
 *
 * The sample order /o/demo exists only in DEMO_MODE: its test runs against E2E_DEMO_BASE_URL
 * (a demo server, e.g. the same standalone build started with DEMO_MODE=true) or the main
 * server when that is a demo; otherwise it is skipped.
 *
 * Needs scripts/e2e-1b.sh with FILES_STORAGE=local, INSTALL_PARTNER_NAME,
 * INSTALL_PARTNER_REQUISITES and TG_CLIENT_BOT_USERNAME (docs/phase-1c-implementation.md
 * section 18). Screenshots: test-results/screens/<project>-order-1c-*.png.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, randomIp, screenshot } from './helpers';
import {
  addToCart,
  checkOutCart,
  KNECHT_LOCAL,
  newClient,
  PAYMENTS_ON,
  rememberSecrets,
  setCartQty,
  TRW_LOCAL,
} from './shop';

const MOCK_URL = process.env.E2E_YOOKASSA_MOCK_URL ?? 'http://127.0.0.1:3199';
const ADMIN_USER = process.env.E2E_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'e2e-admin-password';
const BOT = process.env.TG_CLIENT_BOT_USERNAME ?? 'detaly_test_bot';
const PARTNER = process.env.INSTALL_PARTNER_NAME ?? '';
const DEMO_BASE_URL = process.env.E2E_DEMO_BASE_URL ?? null;
/** The worker answers within seconds; the queues retry with backoff on a hiccup. */
const WORKER_MS = 45_000;

/** A 24x16 JPEG (a filled rectangle, no metadata): the claim photo. */
const JPEG = Buffer.from(
  '/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAQABgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwCVUwAD//2Q==',
  'base64',
);

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

/** Reloads the admin card until its status is `status` (the worker acts in between). */
async function waitForAdminStatus(page: Page, status: string): Promise<void> {
  await expect(async () => {
    await page.reload();
    await expect(adminStatus(page)).toHaveAttribute('data-status', status, { timeout: 1_000 });
  }).toPass({ timeout: WORKER_MS, intervals: [500, 1_000, 2_000] });
}

/** Submits one action form of the admin card (303 back to the card). */
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
  status: string;
  metadata?: Record<string, string>;
  confirmation?: { type?: string; confirmation_data?: string };
}

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

/** The admin card of the order (from the list by its number). */
async function openAdminCard(page: Page, number: string): Promise<string> {
  await page.goto(`/admin?q=${number}`);
  const row = page.locator(`tr[data-order="${number}"]`);
  await expect(row).toHaveCount(1);
  await row.getByRole('link', { name: number }).click();
  await expect(page).toHaveURL(/\/admin\/orders\/[0-9a-f-]{36}$/);
  return page.url();
}

test.describe('order page 1C', () => {
  test.skip(!PAYMENTS_ON, 'needs the worker and the YooKassa mock: bash scripts/e2e-1b.sh');
  test.skip(!PARTNER, 'needs INSTALL_PARTNER_NAME (docs/phase-1c-implementation.md section 18)');

  test('Telegram link, installation booking at ready, a claim with a photo after handover', async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    const project = testInfo.project.name;

    // --- the client: a pay-on-handover order, confirmed --------------------------------------
    const client = newClient();
    // The lines of the GetCheckout.ok fixture (as admin.spec.ts): Knecht OC 90 x 2 and TRW.
    await addToCart(page, 'OC90', KNECHT_LOCAL);
    await setCartQty(page, 'Knecht', 2);
    await addToCart(page, 'GDB1330', TRW_LOCAL);
    const { token, number } = await checkOutCart(page, client, 'pay_on_handover');
    await page.getByTestId('order-confirm-open').click();
    await page.getByTestId('order-confirm-submit').click();
    await expect(page.getByTestId('order-status')).toHaveText('Подтверждён');
    const orderUrl = `/o/${token}`;

    // --- «Статусы в Telegram»: a one-time link token, never the order token -----------------
    const messengers = page.getByTestId('order-messengers');
    await expect(messengers).toContainText('не вход в аккаунт');
    await expect(messengers.getByTestId('messenger-max')).toBeDisabled();
    let deepLink = '';
    await page.route('https://t.me/**', async (route) => {
      deepLink = route.request().url();
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Telegram</p>' });
    });
    await messengers.getByTestId('messenger-telegram').click();
    await expect(page).toHaveURL(/^https:\/\/t\.me\//);
    expect(deepLink).toMatch(new RegExp(`^https://t\\.me/${BOT}\\?start=[A-Za-z0-9_-]{32}$`));
    expect(deepLink).not.toContain(token);
    rememberSecrets(new URL(deepLink).searchParams.get('start') ?? '');
    await page.unroute('https://t.me/**');

    // --- the admin: ordered and arrived -------------------------------------------------------
    const card = await openAdminCard(page, number);
    await act(page, 'recheck');
    await waitForAdminStatus(page, 'ordered_at_supplier');
    const arrive = page.locator('form[data-action="iarr"]');
    await expect(arrive).toHaveCount(2);
    const itemIds = await arrive.evaluateAll((forms) =>
      forms.map((f) => f.getAttribute('data-item') ?? ''),
    );
    for (const itemId of itemIds) await act(page, 'iarr', itemId);
    await expect(adminStatus(page)).toHaveAttribute('data-status', 'ready');

    // --- the client at `ready`: book an installation slot -------------------------------------
    await page.goto(orderUrl);
    await expect(page.getByTestId('order-status')).toHaveText('Готов к выдаче');
    const booking = page.getByTestId('order-install-booking');
    await expect(booking).toContainText(`Установка — услуга ${PARTNER}`);
    await expect(booking).toContainText('оплачивается в сервисе по его чеку');
    await expect(booking).not.toContainText('₽');
    const chips = booking.getByTestId('install-slot');
    expect(await chips.count()).toBeGreaterThan(0);
    expect(await chips.count()).toBeLessThanOrEqual(6);
    await booking.locator('label').nth(1).click();
    await booking.getByTestId('install-submit').click();
    await expect(page).toHaveURL(/\?flash=install_booked#install$/);
    await expect(page.getByTestId('order-flash')).toContainText('Вы записаны');
    await expect(booking.getByTestId('install-booking')).toHaveAttribute(
      'data-status',
      'requested',
    );
    await expect(booking).toContainText('ждём подтверждения мастера');
    await expect(page.getByTestId('order-timeline')).toContainText('Запись на установку');
    await expectNoHorizontalScroll(page, '/o/<token> ready with a booking');
    await screenshot(page, project, 'order-1c-ready');

    // --- the admin: handed over -----------------------------------------------------------------
    await page.goto(card);
    await act(page, 'came');
    await act(page, 'qr');
    const qr = await pendingQr(page.request, number);
    const paid = await page.request.get(qr.confirmation?.confirmation_data ?? '');
    expect(paid.status()).toBe(200);
    await expect(async () => {
      await page.reload();
      await expect(page.locator('form[data-action="handed"]').getByRole('button')).toBeEnabled({
        timeout: 1_000,
      });
    }).toPass({ timeout: WORKER_MS });
    await act(page, 'handed');
    await expect(adminStatus(page)).toHaveAttribute('data-status', 'handed');

    // --- the client after the handover: a claim with a photo ----------------------------------
    await page.goto(orderUrl);
    await expect(page.getByTestId('order-status')).toHaveText('Выдан');
    const claims = page.getByTestId('order-claims');
    await expect(claims.getByTestId('claim-memo')).toHaveAttribute(
      'href',
      '/print/pamyatka-vozvrat.pdf',
    );
    const memo = await page.request.get('/print/pamyatka-vozvrat.pdf');
    expect(memo.status()).toBe(200);
    expect(memo.headers()['content-type']).toContain('application/pdf');
    await expect(claims.getByTestId('claim-kind-delay')).toHaveCount(0);
    // The form is folded under «Оформить претензию» (docs/design-v2.md, «Заказ»).
    await claims.getByTestId('claim-open').click();
    await claims.getByTestId('claim-target').nth(1).check();
    await claims.getByTestId('claim-kind-defect').check();
    await claims.getByTestId('claim-text').fill('Колодка скрипит после первой поездки');
    await claims.locator('input[type="file"]').setInputFiles({
      name: 'claim.jpg',
      mimeType: 'image/jpeg',
      buffer: JPEG,
    });
    await expect(claims.getByText('1 из 3')).toBeVisible();
    await claims.getByTestId('claim-last4').fill(client.phone.last4);
    await claims.getByTestId('claim-submit').click();
    const claimCard = claims.getByTestId('claim-card');
    await expect(claimCard).toBeVisible({ timeout: 15_000 });
    await expect(claimCard).toHaveAttribute('data-open', 'true');
    await expect(claimCard).toContainText('Брак');
    await expect(claimCard).toContainText('Ответим до');
    await expect(claimCard).toContainText('Фото к претензии: 1');
    await expect(claims.getByTestId('claim-steps')).toContainText(
      'Принесите деталь в упаковке в пункт выдачи',
    );
    await expect(page.getByTestId('order-timeline')).toContainText('Претензия принята');
    const html = await page.content();
    expect(html).not.toContain(client.phone.national);
    expect(html).not.toContain(client.name);
    await expectNoHorizontalScroll(page, '/o/<token> handed with a claim');
    await screenshot(page, project, 'order-1c-handed');
  });
});

test.describe('the sample order /o/demo', () => {
  test.skip(!DEMO_BASE_URL, 'needs a DEMO_MODE server: E2E_DEMO_BASE_URL');

  test('blocks, demo screens, no horizontal scroll', async ({ page }, testInfo) => {
    const project = testInfo.project.name;
    const base = DEMO_BASE_URL ?? '';
    const response = await page.goto(`${base}/o/demo`);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('order-install-booking')).toBeVisible();
    await expect(page.getByTestId('claim-form')).toBeHidden();
    await page.getByTestId('claim-open').click();
    await expect(page.getByTestId('claim-form')).toBeVisible();
    // The sample has no packaging photo file: the block is not drawn.
    await expect(page.getByTestId('order-photos')).toHaveCount(0);
    await expectNoHorizontalScroll(page, '/o/demo');
    await screenshot(page, project, 'order-1c-demo');

    // The demo forms are answered by the proxy without reading anything.
    await page.getByTestId('install-submit').click();
    await expect(page).toHaveURL(/\/o\/demo\?demo=install/);
    await expect(page.getByTestId('install-booking')).toBeVisible();
    await page.getByTestId('claim-open').click();
    await page.getByTestId('claim-kind-defect').check();
    await page.getByTestId('claim-submit').click();
    await expect(page).toHaveURL(/\/o\/demo\?demo=claim/);
    await expect(page.getByTestId('claim-card')).toBeVisible();
    await expectNoHorizontalScroll(page, '/o/demo?demo=claim');
    await screenshot(page, project, 'order-1c-demo-claim');
    await page.getByTestId('messenger-telegram').click();
    await expect(page).toHaveURL(/\/o\/demo\?demo=link/);
    await expect(page.getByTestId('order-flash')).toContainText('Демо');
  });
});
