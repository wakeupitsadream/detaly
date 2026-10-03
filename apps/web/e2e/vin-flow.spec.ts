/**
 * Phase 1C VIN request end to end (docs/phase-1c-implementation.md section 11 item 5, PLAN
 * Verification «Фаза 1C» V4) on mobile 375x812 and desktop 1280x800:
 *
 *   client: /vin with two photos -> /vin/sent/<link token> with «Подключить Telegram»;
 *   admin: /admin/vin -> the request -> the answer «MANN W9142X 1» -> the preview shows the
 *   error and no «Отправить клиенту» -> «MANN W 914/2 1» -> «Отправить клиенту»;
 *   client: /p/<token> (the link from the admin card) -> «Оформить и оплатить» -> /checkout ->
 *   prepay order -> «Оплатить» -> the YooKassa mock -> /o/<token>?paid=1 «Оплата получена»;
 *   admin: the request is «Оформлена» and links the order.
 *
 * Needs the 1C stand: scripts/e2e-1c.sh (web with FILES_STORAGE=local, TG_CLIENT_BOT_USERNAME,
 * the worker, the YooKassa mock). The VIN, the phone and every token go to E2E_SECRETS_FILE: the
 * script greps the logs for them. Screenshots: test-results/screens/<project>-vin-flow-*.png.
 */
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { expectNoHorizontalScroll, randomIp, screenshot, testPhone } from './helpers';
import {
  fillContacts,
  giveConsents,
  newClient,
  PAYMENTS_ON,
  rememberSecrets,
  submitAndOpenOrder,
} from './shop';

const MOCK_URL = process.env.E2E_YOOKASSA_MOCK_URL ?? 'http://127.0.0.1:3199';
const ADMIN_USER = process.env.E2E_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'e2e-admin-password';
const PAID_WITHIN_MS = 30_000;

/** A VIN of the right shape, unique per run (not anybody's car). */
function testVin(): string {
  const alphabet = '0123456789ABCDEFGHJKLMNPRSTUVWXYZ';
  let tail = '';
  for (let i = 0; i < 8; i += 1) tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `XTA210990${tail}`;
}

async function photo(color: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const buffer = await sharp({
    create: { width: 320, height: 240, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
  return { name: `${color.slice(1)}.jpg`, mimeType: 'image/jpeg', buffer };
}

test.skip(!PAYMENTS_ON, 'needs the 1C stand: bash scripts/e2e-1c.sh');

test.use({
  // A fresh client ip per test (vin 5/h, checkout 10/h, pay 10/h per ip).
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
  httpCredentials: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  // The payment redirect goes to the mock's http origin (see payments.spec.ts).
  bypassCSP: true,
});

test('VIN request with photos -> answer with a typo -> /p/<token> -> checkout -> paid', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const project = testInfo.project.name;
  const vin = testVin();
  const phone = testPhone();
  rememberSecrets(vin, phone.e164, phone.national);

  // --- client: the form ------------------------------------------------------------------
  await page.goto('/vin');
  const form = page.getByTestId('vin-form');
  await expect(form).toBeVisible();
  await expectNoHorizontalScroll(page, '/vin form');
  await form
    .getByLabel('VIN', { exact: true })
    .fill(`${vin.slice(0, 3).toLowerCase()} ${vin.slice(3)}`);
  await form.getByLabel(/Марка и модель/).fill('Lada Granta 2019');
  await form.getByLabel('Какая деталь нужна').fill('Масляный фильтр на ТО');
  await form
    .locator('input[type="file"][name="photos"]')
    .setInputFiles([await photo('#cc3333'), await photo('#3333cc')]);
  await expect(
    form.getByRole('list', { name: 'Выбранные фото' }).getByRole('listitem'),
  ).toHaveCount(2);
  await form.getByLabel('Телефон').fill(phone.typed);
  await expect(form.getByRole('radio', { name: /Telegram/ })).toBeChecked();
  await expect(form.getByRole('radio', { name: /MAX/ })).toBeDisabled();
  await form.getByRole('checkbox', { name: /согласие на обработку персональных данных/ }).check();
  await form.getByTestId('vin-submit').click();

  await expect(page).toHaveURL(/\/vin\/sent\/[A-Za-z0-9_-]{32}$/);
  const linkToken = new URL(page.url()).pathname.split('/').pop() ?? '';
  rememberSecrets(linkToken);
  await expect(page.getByTestId('vin-sent-title')).toHaveText('Заявка принята');
  const telegram = page.getByTestId('vin-telegram-link');
  await expect(telegram).toHaveAttribute('href', `https://t.me/detaly_test_bot?start=${linkToken}`);
  await expectNoHorizontalScroll(page, '/vin/sent/<link>');
  await screenshot(page, project, 'vin-flow-sent');

  // --- admin: the request and the answer --------------------------------------------------
  await page.goto('/admin/vin?status=open');
  const row = page.locator('tr[data-vin-request]').filter({ hasText: `•••${phone.last4}` });
  await expect(row).toHaveCount(1);
  await row.getByRole('link').click();
  await expect(page).toHaveURL(/\/admin\/vin\/[0-9a-f-]{36}$/);
  const requestPath = new URL(page.url()).pathname;
  await expect(page.getByTestId('admin-vin-vin')).toHaveText(vin);
  await expect(page.getByTestId('admin-vin-phone')).toHaveText(phone.e164);
  await expect(page.getByTestId('admin-vin-photo')).toHaveCount(2);
  const photoSrc = await page.getByTestId('admin-vin-photo').first().getAttribute('src');
  const photoAnswer = await page.request.get(photoSrc ?? '');
  expect(photoAnswer.status()).toBe(200);
  expect(photoAnswer.headers()['content-type']).toBe('image/jpeg');

  await page.getByTestId('vin-answer').fill('MANN W9142X 1');
  await page.getByTestId('vin-check').click();
  await expect(page.getByTestId('admin-done')).toContainText('ошибок 1');
  await expect(page.locator('[data-testid="vin-preview-line"][data-status="error"]')).toHaveCount(
    1,
  );
  await expect(page.getByTestId('vin-send')).toHaveCount(0);
  await screenshot(page, project, 'vin-flow-admin-error');

  await page
    .getByTestId('vin-answer')
    .fill('> Подобрали по VIN, оригинальный размер\nMANN W 914/2 1');
  await page.getByTestId('vin-check').click();
  await expect(page.getByTestId('admin-done')).toContainText('ошибок нет');
  await expect(page.locator('[data-testid="vin-preview-line"][data-status="ok"]')).toHaveCount(1);
  await page.getByTestId('vin-send').click();
  await expect(page.getByTestId('admin-done')).toHaveText('Подборка отправлена клиенту');
  await expect(page.getByTestId('admin-vin-status')).toHaveText('Подборка отправлена');
  const proposalHref = (await page.getByTestId('vin-proposal-link').getAttribute('href')) ?? '';
  expect(proposalHref).toMatch(/^\/p\/[A-Za-z0-9_-]{32}$/);
  rememberSecrets(proposalHref.slice('/p/'.length));

  // --- client: the proposal and checkout --------------------------------------------------
  const proposal = await page.goto(proposalHref);
  expect(proposal?.headers()['x-robots-tag'] ?? '').toContain('noindex');
  expect(proposal?.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page.getByTestId('proposal-comment')).toContainText('оригинальный размер');
  await expect(page.getByTestId('proposal-line')).toHaveCount(1);
  await expect(page.getByTestId('proposal-guarantee')).toBeVisible();
  await expectNoHorizontalScroll(page, '/p/<token>');
  await screenshot(page, project, 'vin-flow-proposal');
  const take =
    project === 'mobile'
      ? page.getByTestId('proposal-take-bar')
      : page.getByTestId('proposal-take');
  await take.click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByTestId('payment-scheme')).toHaveAttribute('data-scheme', 'prepay');

  const client = newClient();
  await fillContacts(page, { ...client, phone });
  await giveConsents(page);
  const { token } = await submitAndOpenOrder(page);
  await expect(page.getByTestId('order-status')).toHaveText('Ждёт оплаты');

  const payment = page.getByTestId('order-payment');
  const mockPage = page.waitForRequest((r) => r.url().startsWith(`${MOCK_URL}/checkout/`));
  await payment.getByTestId('pay-button').click();
  await mockPage;
  await expect(page).toHaveURL(new RegExp(`/o/${token}\\?paid=1`));
  await expect(payment.getByTestId('pay-paid')).toHaveText('Оплата получена, спасибо!', {
    timeout: PAID_WITHIN_MS,
  });
  await expect(page.getByTestId('order-status')).toHaveText('Подтверждён');

  // --- admin: converted ------------------------------------------------------------------
  await page.goto(requestPath);
  await expect(page.getByTestId('admin-vin-status')).toHaveText('Оформлена');
  await expect(page.getByTestId('admin-vin-orders')).toContainText(/DT-\d{6}/);
  await screenshot(page, project, 'vin-flow-admin-converted');
});

test('a VIN with the letter O is refused with the O/0 hint; the values stay on screen', async ({
  page,
}) => {
  await page.goto('/vin');
  const form = page.getByTestId('vin-form');
  const phone = testPhone();
  rememberSecrets(phone.e164, phone.national);
  await form.getByLabel('VIN', { exact: true }).fill('XTA2109O0Y1234567');
  await form.getByLabel('Какая деталь нужна').fill('Колодки');
  await form.getByLabel('Телефон').fill(phone.typed);
  await form.getByRole('checkbox', { name: /согласие на обработку персональных данных/ }).check();
  await form.getByTestId('vin-submit').click();
  await expect(form.getByText('В VIN не бывает букв O, I и Q')).toBeVisible();
  await expect(page).toHaveURL(/\/vin$/);
  await expect(form.getByLabel('Какая деталь нужна')).toHaveValue('Колодки');
});
