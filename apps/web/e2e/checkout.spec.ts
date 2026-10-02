/**
 * Phase 1A end to end (docs/phase-1a-implementation.md section 9) on mobile 375x812 and
 * desktop 1280x800 against the standalone server: search -> cart -> checkout -> /o/<token>,
 * the split of a mixed cart and cancellation, 409 on a stale total, no order without consent,
 * excluded goods never reach the cart.
 *
 * Server env: APP_BASE_URL=http://127.0.0.1:3100 (Origin check), RKN_NOTICE_NUMBER and
 * LEGAL_*_VERSION (checkout gate), PICKUP_*, TRUSTED_IP_HEADER=x-real-ip, ROSSKO_MODE=fixtures.
 * Every test runs with its own client ip (rate limit buckets: 10 checkouts and 5 cancels an
 * hour) and its own phone number. Screenshots: test-results/screens/<project>-<slug>.png.
 *
 * Optional E2E_WEB_LOG=<path of the server log>: after the tests the log is checked for the
 * phones and names typed here (no personal data in logs).
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Response } from '@playwright/test';
import { expectNoHorizontalScroll, randomIp, screenshot, testName, testPhone } from './helpers';

/** Offer ids (OfferView.id = articleNorm:brand:stockId) in the GetSearch.OC90 fixture. */
const KNECHT_LOCAL = 'OC90:Knecht:ORB1';
const BOSCH_TO_ORDER = '0451103079:BOSCH:MSK7';
/** Engine oil in GetSearch.EDGE5W40: an excluded (marked goods) group. */
const OIL_EXCLUDED = 'EDGE5W40:CASTROL:ORB1';

const ORDER_PATH_RE = /^\/o\/[A-Za-z0-9_-]{43}$/;
const PROMISE_RE = /к (пн|вт|ср|чт|пт|сб|вс) \d{1,2} [а-я]+/;

/** What this worker typed into the forms: the server log must contain none of it. */
const typed: { phones: string[]; names: string[] } = { phones: [], names: [] };

// A fresh client ip per test: a test never eats another one's rate limit budget.
test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
});

function newClient(): { phone: ReturnType<typeof testPhone>; name: string } {
  const phone = testPhone();
  const name = testName();
  typed.phones.push(phone.e164, phone.national);
  typed.names.push(name);
  return { phone, name };
}

/** "В корзину" on the search row of one offer; the form answers 303 -> /cart?added=1. */
async function addToCart(page: Page, query: string, offerId: string): Promise<void> {
  await page.goto(`/search?q=${encodeURIComponent(query)}`);
  const form = page
    .getByTestId('add-to-cart')
    .filter({ has: page.locator(`input[name="offerId"][value="${offerId}"]`) });
  await expect(form).toHaveCount(1);
  await form.getByRole('button', { name: /В корзину/ }).click();
  await expect(page).toHaveURL(/\/cart\?added=1$/);
}

/** «к …» of every line by brand, e.g. { Knecht: 'к сб 3 октября' }. */
async function linePromises(
  page: Page,
  lineTestId: string,
  promiseTestId: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const line of await page.getByTestId(lineTestId).all()) {
    const text = (await line.innerText()).toLowerCase();
    const brand = text.includes('knecht') ? 'Knecht' : text.includes('bosch') ? 'BOSCH' : text;
    const promise = (await line.getByTestId(promiseTestId).innerText()).match(PROMISE_RE);
    expect(promise, `${lineTestId} ${brand}: delivery promise`).not.toBeNull();
    result[brand] = promise?.[0] ?? '';
  }
  return result;
}

function submitButton(page: Page) {
  return page.getByTestId('checkout-form').getByRole('button', { name: 'Оформить заказ' });
}

async function fillContacts(
  page: Page,
  client: { phone: ReturnType<typeof testPhone>; name: string },
): Promise<void> {
  await page.getByLabel('Телефон', { exact: true }).fill(client.phone.typed);
  await page.getByLabel('Имя', { exact: true }).fill(client.name);
  await page.getByRole('radio', { name: 'MAX' }).check();
}

async function giveConsents(page: Page): Promise<void> {
  await page.getByRole('checkbox', { name: /Принимаю условия/ }).check();
  await page.getByRole('checkbox', { name: /согласие на обработку персональных данных/ }).check();
}

/** Submits the checkout form and waits for the order page document. */
async function submitAndOpenOrder(page: Page): Promise<Response> {
  const orderDocument = page.waitForResponse(
    (r) =>
      r.request().resourceType() === 'document' && ORDER_PATH_RE.test(new URL(r.url()).pathname),
  );
  await submitButton(page).click();
  const response = await orderDocument;
  await expect(page).toHaveURL((url) => ORDER_PATH_RE.test(url.pathname));
  expect(response.status()).toBe(200);
  return response;
}

function expectPrivateOrderHeaders(response: Response): void {
  const headers = response.headers();
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-robots-tag'] ?? '').toContain('noindex');
}

async function expectPickupPoint(page: Page): Promise<void> {
  const pickup = page.getByTestId('order-pickup');
  await expect(pickup).toBeVisible();
  const address = process.env.PICKUP_ADDRESS;
  if (address) await expect(pickup).toContainText(address);
  else await expect(pickup.locator('address')).toBeVisible();
}

test('mixed cart: prepayment order from search to the order page', async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const client = newClient();

  await addToCart(page, 'OC90', KNECHT_LOCAL);
  await expectNoHorizontalScroll(page, '/search?q=OC90');
  await addToCart(page, 'OC90', BOSCH_TO_ORDER);

  // Cart: two lines, mixed payment notice with the split offer.
  const lines = page.getByTestId('cart-line');
  await expect(lines).toHaveCount(2);
  await expect(lines.filter({ hasText: 'Knecht' })).toContainText('OC 90');
  await expect(lines.filter({ hasText: 'BOSCH' })).toContainText('0 451 103 079');
  const notice = page.getByTestId('payment-mode-notice');
  await expect(notice).toContainText('Одним заказом — предоплата 100%');
  await expect(notice.getByTestId('split-order')).toHaveText('Разделить на два заказа');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  const cartPromises = await linePromises(page, 'cart-line', 'cart-line-promise');
  expect(Object.keys(cartPromises)).toHaveLength(2);
  await expectNoHorizontalScroll(page, '/cart');
  await screenshot(page, project, 'cart');

  // Checkout: one order for the whole cart, prepayment explained, button off until consent.
  await page.getByTestId('checkout-link').click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByTestId('checkout-line')).toHaveCount(2);
  const scheme = page.getByTestId('payment-scheme');
  await expect(scheme).toHaveAttribute('data-scheme', 'prepay');
  await expect(scheme).toContainText('Предоплата 100%');
  await expect(page.getByTestId('pickup-point')).toBeVisible();
  // Each line promises the same day as in the cart (eta buffer included on both pages).
  expect(await linePromises(page, 'checkout-line', 'checkout-line-promise')).toEqual(cartPromises);
  await expect(submitButton(page)).toBeDisabled();
  const totalText = (await page.getByTestId('checkout-total').textContent())?.trim() ?? '';
  expect(totalText).toMatch(/\d\s?₽$/);
  await expectNoHorizontalScroll(page, '/checkout');
  await screenshot(page, project, 'checkout');

  await fillContacts(page, client);
  await expect(submitButton(page)).toBeDisabled();
  await giveConsents(page);
  await expect(submitButton(page)).toBeEnabled();
  const response = await submitAndOpenOrder(page);

  // Order page.
  expectPrivateOrderHeaders(response);
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.getByTestId('order-number')).toContainText(/DT-\d+/);
  await expect(page.getByTestId('order-status')).toHaveText('Ждёт оплаты');
  await expect(page.getByTestId('order-promise')).toContainText(PROMISE_RE);
  await expectPickupPoint(page);
  const payment = page.getByTestId('order-payment');
  await expect(payment).toContainText('Предоплата 100% онлайн');
  await expect(payment.getByTestId('pay-button')).toBeDisabled();
  await expect(payment.getByTestId('pay-button')).toContainText('Оплатить');
  await expect(payment).toContainText('Оплата подключается');
  await expect(page.getByTestId('order-items').getByTestId('order-item')).toHaveCount(2);
  await expect(page.getByTestId('order-total')).toHaveText(totalText);
  await expect(page.getByTestId('order-timeline')).toContainText('Заказ оформлен');
  await expect(page.getByTestId('messenger-max')).toHaveAttribute('data-selected', 'true');
  await expect(page.getByTestId('cart-reminder')).toHaveCount(0);
  await expect(page.getByTestId('cancel-open')).toBeVisible();
  // The order page never shows the client's phone or name.
  const html = await page.content();
  expect(html).not.toContain(client.phone.national);
  expect(html).not.toContain(client.name);
  await expectNoHorizontalScroll(page, '/o/<token>');
  await screenshot(page, project, 'order');

  // Checked-out lines left the cart.
  await page.goto('/cart');
  await expect(page.getByTestId('cart-empty')).toBeVisible();
});

test('split a mixed cart, cancel the first order, then check out the rest', async ({
  page,
}, testInfo) => {
  const project = testInfo.project.name;
  const client = newClient();

  await addToCart(page, 'OC90', KNECHT_LOCAL);
  await addToCart(page, 'OC90', BOSCH_TO_ORDER);
  await expect(page.getByTestId('cart-line')).toHaveCount(2);

  await page.getByTestId('split-order').click();
  await expect(page).toHaveURL(/\/checkout\?part=local$/);
  const lines = page.getByTestId('checkout-line');
  await expect(lines).toHaveCount(1);
  await expect(lines).toContainText('Knecht');
  await expect(page.getByTestId('payment-scheme')).toHaveAttribute(
    'data-scheme',
    'pay_on_handover',
  );
  await expectNoHorizontalScroll(page, '/checkout?part=local');

  await fillContacts(page, client);
  await giveConsents(page);
  expectPrivateOrderHeaders(await submitAndOpenOrder(page));

  await expect(page.getByTestId('order-status')).toHaveText('Ждёт подтверждения');
  await expect(page.getByTestId('order-payment')).toContainText('Оплата при получении');
  await expect(page.getByTestId('order-timeline')).toContainText(
    'Заказ оформлен, оплата при получении',
  );
  await expect(page.getByTestId('order-items').getByTestId('order-item')).toHaveCount(1);
  const reminder = page.getByTestId('cart-reminder');
  await expect(reminder).toContainText('оформить второй заказ');
  await expect(reminder).toHaveAttribute('href', '/checkout?part=order');

  // Wrong digits: an error, the order stays.
  await page.getByTestId('cancel-open').click();
  const last4 = page.getByTestId('cancel-last4');
  await expect(last4).toBeFocused();
  const wrong = client.phone.last4.replace(/\d/g, (d) => String((Number(d) + 1) % 10));
  await last4.fill(wrong);
  await page.getByTestId('cancel-submit').click();
  await expect(page.getByTestId('cancel-error')).toContainText('не совпадают');
  await expect(page.getByTestId('cancel-error')).toContainText('Осталось попыток: 4');
  await expect(page.getByTestId('order-status')).toHaveText('Ждёт подтверждения');
  await expectNoHorizontalScroll(page, '/o/<token> cancel error');

  // Right digits: cancelled by the state machine, no cancel button any more.
  await last4.fill(client.phone.last4);
  await page.getByTestId('cancel-submit').click();
  await expect(page.getByTestId('order-status')).toHaveText('Отменён');
  await expect(page.getByTestId('order-timeline')).toContainText('Вы отменили заказ');
  await expect(page.getByTestId('order-cancel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Отменить заказ' })).toHaveCount(0);
  await expectNoHorizontalScroll(page, '/o/<token> cancelled');
  await screenshot(page, project, 'order-cancelled');

  // A reload agrees: the cancellation is stored, not just rendered.
  await page.reload();
  await expect(page.getByTestId('order-status')).toHaveText('Отменён');
  await expect(page.getByTestId('cancel-open')).toHaveCount(0);

  // The to-order part waits in the cart for the second order.
  await page.getByTestId('cart-reminder').click();
  await expect(page).toHaveURL(/\/checkout\?part=order$/);
  const rest = page.getByTestId('checkout-line');
  await expect(rest).toHaveCount(1);
  await expect(rest).toContainText('BOSCH');
  await expect(page.getByTestId('payment-scheme')).toHaveAttribute('data-scheme', 'prepay');
  await expectNoHorizontalScroll(page, '/checkout?part=order');
});

test('stale total: 409 shows the diff banner, a resubmit creates the order', async ({ page }) => {
  const client = newClient();
  await addToCart(page, 'OC90', KNECHT_LOCAL);
  await page.goto('/checkout');
  const totalText = (await page.getByTestId('checkout-total').textContent())?.trim() ?? '';
  await fillContacts(page, client);
  await giveConsents(page);

  // The client saw a total 100 ₽ lower than the fresh one.
  await page.route('**/api/checkout', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({
      postData: JSON.stringify({
        ...body,
        expectedTotalKop: Number(body.expectedTotalKop) - 10_000,
      }),
    });
  });
  const staleAnswer = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/checkout' && r.request().method() === 'POST',
  );
  await submitButton(page).click();
  const stale = await staleAnswer;
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ error: 'stale' });
  await expect(
    page.getByTestId('diff-banner').filter({ hasText: 'Корзина изменилась' }),
  ).toBeVisible();
  await expect(page.getByTestId('checkout-form')).toContainText('Заказ не оформлен');
  await expect(page).toHaveURL(/\/checkout$/);
  await expectNoHorizontalScroll(page, '/checkout 409');
  await page.unroute('**/api/checkout');

  // Same form, now with the server's figures: the order is created.
  await expect(submitButton(page)).toBeEnabled();
  expectPrivateOrderHeaders(await submitAndOpenOrder(page));
  await expect(page.getByTestId('order-status')).toHaveText('Ждёт подтверждения');
  await expect(page.getByTestId('order-total')).toHaveText(totalText);
  await expect(page.getByTestId('order-items').getByTestId('order-item')).toHaveCount(1);
});

test('no consent, no order: the button stays off and the API answers 422', async ({ page }) => {
  const client = newClient();
  await addToCart(page, 'OC90', KNECHT_LOCAL);
  await page.goto('/checkout');
  await fillContacts(page, client);

  const offer = page.getByRole('checkbox', { name: /Принимаю условия/ });
  const pd = page.getByRole('checkbox', { name: /согласие на обработку персональных данных/ });
  await offer.check();
  await expect(submitButton(page)).toBeDisabled();
  await pd.check();
  await expect(submitButton(page)).toBeEnabled();
  await pd.uncheck();
  await expect(submitButton(page)).toBeDisabled();
  await offer.uncheck();
  await pd.check();
  await expect(submitButton(page)).toBeDisabled();

  const form = page.getByTestId('checkout-form');
  const payload = {
    part: 'all',
    phone: client.phone.typed,
    name: client.name,
    channel: 'max',
    acceptOffer: true,
    consentMarketing: false,
    expectedTotalKop: Number(await form.locator('input[name="expectedTotalKop"]').inputValue()),
    itemsHash: await form.locator('input[name="itemsHash"]').inputValue(),
    checkoutKey: await form.locator('input[name="checkoutKey"]').inputValue(),
    website: '',
  };
  // A same-origin fetch from the page, as the form would send it, minus the consent.
  const answers = await page.evaluate(async (base) => {
    const post = async (body: Record<string, unknown>) => {
      const r = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    return [await post(base), await post({ ...base, consentPd: false })];
  }, payload);
  for (const answer of answers) {
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ error: 'consent_required' });
    expect(answer.body.fields).toHaveProperty('consentPd');
  }

  // No order: checkout would have taken the line out of the cart.
  await page.goto('/cart');
  await expect(page.getByTestId('cart-line')).toHaveCount(1);
});

test('excluded goods: no "В корзину" on search, the cart API answers 422', async ({ page }) => {
  await page.goto('/search?q=EDGE5W40');
  const rows = page.getByTestId('offer-row');
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText('Не продаём онлайн');
  await expect(page.getByTestId('add-to-cart')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /В корзину/ })).toHaveCount(0);
  await expectNoHorizontalScroll(page, '/search?q=EDGE5W40');

  const answer = await page.evaluate(async (offerId) => {
    const r = await fetch('/api/cart/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ q: 'EDGE5W40', offerId, qty: 1 }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  }, OIL_EXCLUDED);
  expect(answer.status).toBe(422);
  expect(answer.body).toMatchObject({ error: 'excluded' });

  await page.goto('/cart');
  await expect(page.getByTestId('cart-empty')).toBeVisible();
});

test.afterAll(async () => {
  const logPath = process.env.E2E_WEB_LOG;
  if (!logPath || typed.phones.length === 0) return;
  const log = await readFile(logPath, 'utf8');
  for (const value of [...typed.phones, ...typed.names]) {
    expect(log.includes(value), 'personal data in the server log').toBe(false);
  }
});
