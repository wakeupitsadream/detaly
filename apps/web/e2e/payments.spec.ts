/**
 * Phase 1B online payment end to end (docs/phase-1b-implementation.md section 16.4) on mobile
 * 375x812 and desktop 1280x800: a prepay order -> «Оплатить N ₽» -> the YooKassa mock page
 * (scripts/yookassa-mock-server.ts marks the payment, POSTs the notification to web with an
 * allowlisted X-Real-IP and redirects back) -> /o/<token>?paid=1 «Проверяем оплату…» -> the
 * worker re-reads the payment -> «Оплата получена» and «Подтверждён» within 30 s.
 *
 * Needs the whole 1B stand: scripts/e2e-1b.sh (web, worker, mock, E2E_PAYMENTS=on).
 * Screenshots: test-results/screens/<project>-pay-*.png.
 */
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, randomIp, screenshot } from './helpers';
import { addToCart, BOSCH_TO_ORDER, checkOutCart, newClient, PAYMENTS_ON } from './shop';

const MOCK_URL = process.env.E2E_YOOKASSA_MOCK_URL ?? 'http://127.0.0.1:3199';
const PAID_WITHIN_MS = 30_000;

test.skip(!PAYMENTS_ON, 'needs the YooKassa mock and the worker: bash scripts/e2e-1b.sh');

test.use({
  // A fresh client ip per test (checkout 10/h, pay 10/h per ip).
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
  // The CSP of the site lets a form submission redirect only to itself and to YooKassa
  // (form-action, apps/web/src/lib/csp.ts, sent by the proxy): the mock's http://127.0.0.1
  // page is neither, so Chromium would block the 303 of «Оплатить». The policy itself is
  // covered by the web unit tests and e2e/csp-404.spec.ts; here it is bypassed for the mock
  // origin only by necessity.
  bypassCSP: true,
});

/** A prepay order (the BOSCH filter is not in Orenburg) on its /o/<token> page. */
async function prepayOrder(page: Page) {
  const client = newClient();
  await addToCart(page, 'OC90', BOSCH_TO_ORDER);
  const order = await checkOutCart(page, client, 'prepay');
  await expect(page.getByTestId('order-status')).toHaveText('Ждёт оплаты');
  return order;
}

test('prepay: «Оплатить» -> YooKassa page -> paid within 30 s', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const project = testInfo.project.name;
  const { token, totalText } = await prepayOrder(page);

  const payment = page.getByTestId('order-payment');
  const pay = payment.getByTestId('pay-button');
  await expect(pay).toBeEnabled();
  await expect(pay).toHaveText(`Оплатить ${totalText}`);
  await expectNoHorizontalScroll(page, '/o/<token> awaiting payment');
  await screenshot(page, project, 'pay-order');

  // The form posts to web, web creates the payment at the mock and redirects to its page, the
  // page pays and sends the browser back to return_url.
  const mockPage = page.waitForRequest((r) => r.url().startsWith(`${MOCK_URL}/checkout/`));
  await pay.click();
  await mockPage;
  await expect(page).toHaveURL(new RegExp(`/o/${token}\\?paid=1`));

  // «Проверяем оплату…» refreshes every 5 s until the worker has applied the notification.
  await expect(payment.getByTestId('pay-paid')).toHaveText('Оплата получена, спасибо!', {
    timeout: PAID_WITHIN_MS,
  });
  await expect(page.getByTestId('order-status')).toHaveText('Подтверждён');
  await expect(payment.getByTestId('pay-button')).toHaveCount(0);
  await expect(page.getByTestId('order-timeline')).toContainText(/оплат/i);
  await expectNoHorizontalScroll(page, '/o/<token> paid');
  await screenshot(page, project, 'pay-paid');

  // The status is stored, not just rendered.
  await page.goto(`/o/${token}`);
  await expect(page.getByTestId('order-status')).toHaveText('Подтверждён');
});

test('the payment is declined on the YooKassa page: «Оплата не прошла», the order is cancelled', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000);
  const { token } = await prepayOrder(page);

  // What the «Оплатить» form does, without following the redirect: the mock page link.
  const answer = await page.request.post(`/api/orders/${token}/pay`, {
    headers: { Origin: new URL(baseURL ?? '').origin, Accept: 'text/html' },
    maxRedirects: 0,
  });
  expect(answer.status()).toBe(303);
  const location = answer.headers().location ?? '';
  expect(location.startsWith(`${MOCK_URL}/checkout/`)).toBe(true);

  // A second click reuses the same live payment (one payment per order, decision Б5).
  const again = await page.request.post(`/api/orders/${token}/pay`, {
    headers: { Origin: new URL(baseURL ?? '').origin, Accept: 'text/html' },
    maxRedirects: 0,
  });
  expect(again.headers().location).toBe(location);

  await page.goto(`${location}?result=canceled`);
  await expect(page).toHaveURL(new RegExp(`/o/${token}\\?paid=1`));
  await expect(page.getByTestId('order-status')).toHaveText('Отменён', {
    timeout: PAID_WITHIN_MS,
  });
  await expect(page.getByTestId('pay-paid')).toHaveCount(0);
  await expectNoHorizontalScroll(page, '/o/<token> payment declined');
  await screenshot(page, testInfo.project.name, 'pay-declined');
});

test('a YooKassa notification from an address outside the allowlist is refused', async ({
  request,
}) => {
  const forged = await request.post('/api/webhooks/yookassa', {
    headers: { 'X-Real-IP': '203.0.113.9', 'Content-Type': 'application/json' },
    data: {
      type: 'notification',
      event: 'payment.succeeded',
      object: { id: '2f0e5a4e-000f-5000-8000-1b2c3d4e5f60', status: 'succeeded', paid: true },
    },
  });
  expect(forged.status()).toBe(403);
  expect(forged.headers()['cache-control']).toContain('no-store');
});
