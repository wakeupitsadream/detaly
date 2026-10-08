/**
 * Step 3 end to end (docs/reviews.md) on mobile 375x812 and desktop 1280x800.
 *
 * With the review links (scripts/e2e-1c.sh sets fake REVIEW_URL_YANDEX / REVIEW_URL_2GIS):
 *   admin: /admin/reviews -> the rating snapshot (4,9 · 37 and 4,8 · 12, today) -> the home page
 *   and /search show «★ 4,9 на Яндекс Картах · 37 отзывов» with the date; /review with its
 *   buttons and the phone; the printable counter sign; a pay-on-handover order taken to «Выдан»
 *   -> «Оцените нас» on /o/<token> -> the Яндекс button opens our redirect, which journals the
 *   open (the funnel grows by one) and lands on the card (a stub: no network) without a Referer.
 *   The snapshot is cleared at the end (also when the test fails half way), so the other specs see
 *   the storefront without a rating.
 * Without the links (scripts/e2e-1b.sh): /review answers 404, the redirect of any order too, and
 * /admin/reviews says the links are not set.
 *
 * Screenshots for a human look: test-results/step3/<project>-*.png.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, randomIp } from './helpers';
import {
  addToCart,
  checkOutCart,
  KNECHT_LOCAL,
  newClient,
  PAYMENTS_ON,
  setCartQty,
  TRW_LOCAL,
} from './shop';

const ADMIN_USER = process.env.E2E_ADMIN_USER;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const MOCK_URL = process.env.E2E_YOOKASSA_MOCK_URL ?? 'http://127.0.0.1:3199';
const YANDEX = process.env.REVIEW_URL_YANDEX ?? '';
const TWO_GIS = process.env.REVIEW_URL_2GIS ?? '';
const LINKS_ON = YANDEX !== '' && TWO_GIS !== '';
/** The worker answers within seconds; the queues retry with backoff on a hiccup. */
const WORKER_MS = 45_000;

test.skip(!ADMIN_USER, 'needs the admin (ADMIN_BASIC_AUTH): bash scripts/e2e-1c.sh');

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
  httpCredentials: { username: ADMIN_USER ?? 'admin', password: ADMIN_PASSWORD },
});

async function shot(page: Page, project: string, slug: string): Promise<void> {
  await page.screenshot({ path: `test-results/step3/${project}-${slug}.png`, fullPage: true });
}

/** Fills and saves the snapshot form of /admin/reviews (empty strings clear a platform). */
async function saveSnapshot(
  page: Page,
  values: { yandex: [string, string]; twoGis: [string, string] },
): Promise<string> {
  const response = await page.goto('/admin/reviews');
  expect(response?.status()).toBe(200);
  const form = page.getByTestId('reviews-save');
  await form.locator('input[name="rating_yandex"]').fill(values.yandex[0]);
  await form.locator('input[name="count_yandex"]').fill(values.yandex[1]);
  await form.locator('input[name="rating_2gis"]').fill(values.twoGis[0]);
  await form.locator('input[name="count_2gis"]').fill(values.twoGis[1]);
  await form.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page).toHaveURL(/\/admin\/reviews\?done=/);
  return (await page.getByTestId('admin-done').textContent()) ?? '';
}

/** No rating on the storefront: both platforms empty (the next save is «без оценок»). */
async function clearSnapshot(page: Page): Promise<void> {
  const done = await saveSnapshot(page, { yandex: ['', ''], twoGis: ['', ''] });
  expect(done).toMatch(/Сохранено: без оценок|Без изменений/);
}

/** The first-open count of a platform in the 30-day funnel of /admin/reviews. */
async function openedLast30(page: Page, label: string): Promise<number> {
  await page.goto('/admin/reviews');
  const row = page.getByTestId('reviews-funnel').locator('tr', { hasText: label });
  return Number(await row.getByTestId('funnel-30').textContent());
}

// --- the handover flow of the admin (as order-1c.spec.ts) ------------------------------------

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

async function waitForAdminStatus(page: Page, status: string): Promise<void> {
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('admin-status')).toHaveAttribute('data-status', status, {
      timeout: 1_000,
    });
  }).toPass({ timeout: WORKER_MS, intervals: [500, 1_000, 2_000] });
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

/** A pay-on-handover order taken to «Выдан» through the admin; returns its token. */
async function handedOrder(page: Page): Promise<string> {
  const client = newClient();
  // The lines of the GetCheckout.ok fixture: Knecht OC 90 x 2 and TRW.
  await addToCart(page, 'OC90', KNECHT_LOCAL);
  await setCartQty(page, 'Knecht', 2);
  await addToCart(page, 'GDB1330', TRW_LOCAL);
  const { token, number } = await checkOutCart(page, client, 'pay_on_handover');
  await page.getByTestId('order-confirm-open').click();
  await page.getByTestId('order-confirm-submit').click();
  await expect(page.getByTestId('order-status')).toHaveText('Подтверждён');
  // Before the handover there is no «Оцените нас».
  await expect(page.getByTestId('order-reviews')).toHaveCount(0);

  await page.goto(`/admin?q=${number}`);
  const row = page.locator(`tr[data-order="${number}"]`);
  await expect(row).toHaveCount(1);
  await row.getByRole('link', { name: number }).click();
  await act(page, 'recheck');
  await waitForAdminStatus(page, 'ordered_at_supplier');
  const arrive = page.locator('form[data-action="iarr"]');
  await expect(arrive).toHaveCount(2);
  const itemIds = await arrive.evaluateAll((forms) =>
    forms.map((f) => f.getAttribute('data-item') ?? ''),
  );
  for (const itemId of itemIds) await act(page, 'iarr', itemId);
  await act(page, 'came');
  await act(page, 'qr');
  const qr = await pendingQr(page.request, number);
  expect((await page.request.get(qr.confirmation?.confirmation_data ?? '')).status()).toBe(200);
  await expect(async () => {
    await page.reload();
    await expect(page.locator('form[data-action="handed"]').getByRole('button')).toBeEnabled({
      timeout: 1_000,
    });
  }).toPass({ timeout: WORKER_MS });
  await act(page, 'handed');
  await expect(page.getByTestId('admin-status')).toHaveAttribute('data-status', 'handed');
  return token;
}

test.describe('with the review links', () => {
  test.skip(!LINKS_ON, 'needs REVIEW_URL_YANDEX and REVIEW_URL_2GIS: bash scripts/e2e-1c.sh');

  test('the rating snapshot on the storefront, /review and the counter sign', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const project = testInfo.project.name;
    try {
      // --- /admin/reviews: the links are set, the numbers are typed in ----------------------
      await page.goto('/admin/reviews');
      await expect(page.getByTestId('reviews-link-yandex')).toHaveAttribute('data-set', 'true');
      await expect(page.getByTestId('reviews-link-2gis')).toHaveAttribute('data-set', 'true');
      const done = await saveSnapshot(page, { yandex: ['4,9', '37'], twoGis: ['4.8', '12'] });
      expect(done).toMatch(/^Сохранено: Яндекс Карты 4,9 · 37, 2ГИС 4,8 · 12, на \d{1,2} [а-я]+$/);
      await expect(page.getByTestId('reviews-storefront-line')).toBeVisible();
      await expect(page.getByTestId('reviews-audit-row').first()).toContainText('4,9 · 37');
      await expectNoHorizontalScroll(page, '/admin/reviews');
      await shot(page, project, 'admin-reviews');

      // --- the home page: the line in the dark panel ------------------------------------------
      const home = await page.goto('/');
      expect(home?.status()).toBe(200);
      const panel = page.getByTestId('home-why');
      const rating = panel.getByTestId('rating-line');
      await expect(rating).toBeVisible();
      await expect(rating).toContainText('4,9');
      await expect(rating).toContainText('на Яндекс Картах');
      await expect(rating).toContainText('37 отзывов');
      await expect(rating.getByTestId('rating-2gis')).toContainText('2ГИС');
      await expect(rating.getByTestId('rating-2gis')).toContainText('4,8 · 12');
      await expect(rating.getByTestId('rating-date')).toHaveText(/^на \d{1,2} [а-я]+$/);
      await expect(rating.getByTestId('rating-link-yandex')).toHaveAttribute('href', YANDEX);
      await expect(rating.getByTestId('rating-link-2gis')).toHaveAttribute('href', TWO_GIS);
      expect(await page.content()).not.toMatch(/AggregateRating|itemprop="rating/);
      await expectNoHorizontalScroll(page, '/ with the rating');
      await panel.screenshot({ path: `test-results/step3/${project}-home-rating.png` });
      await shot(page, project, 'home');

      // --- /search: one compact line above the offers -----------------------------------------
      const search = await page.goto('/search?q=OC90');
      expect(search?.status()).toBe(200);
      const line = page.getByTestId('rating-line');
      await expect(line).toBeVisible();
      await expect(line).toContainText('37 отзывов');
      const lineBox = await line.boundingBox();
      const firstOffer = await page.getByTestId('offer-row').first().boundingBox();
      expect(lineBox && firstOffer && lineBox.y < firstOffer.y).toBe(true);
      await expectNoHorizontalScroll(page, '/search with the rating');
      await page
        .getByTestId('results-summary')
        .locator('..')
        .screenshot({ path: `test-results/step3/${project}-search-rating.png` });
      await shot(page, project, 'search');

      // --- /review: the QR target -------------------------------------------------------------
      const review = await page.goto('/review');
      expect(review?.status()).toBe(200);
      expect(review?.headers()['x-robots-tag'] ?? '').toContain('noindex');
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Оставьте отзыв о');
      await expect(page.getByTestId('review-yandex')).toHaveAttribute('href', YANDEX);
      await expect(page.getByTestId('review-2gis')).toHaveAttribute('href', TWO_GIS);
      for (const id of ['review-yandex', 'review-2gis']) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(48);
      }
      await expect(page.getByTestId('review-problem')).toContainText('Что-то не так с заказом?');
      await expect(page.getByTestId('review-problem').locator('a[href^="tel:"]')).toHaveCount(1);
      await expectNoHorizontalScroll(page, '/review');
      await shot(page, project, 'review');

      // --- the counter sign ------------------------------------------------------------------
      const sign = await page.goto('/admin/reviews/sign');
      expect(sign?.status()).toBe(200);
      await expect(page.getByTestId('review-sign')).toContainText(
        'Оставьте отзыв — наведите камеру',
      );
      await expect(page.getByTestId('review-sign-platforms')).toHaveText('Яндекс Карты · 2ГИС');
      await expect(page.getByTestId('review-sign-qr')).toBeVisible();
      await expectNoHorizontalScroll(page, '/admin/reviews/sign');
      await shot(page, project, 'admin-sign');
      // In print only the sign: the admin menu and the buttons are hidden.
      await page.emulateMedia({ media: 'print' });
      await expect(page.getByTestId('admin-nav')).toBeHidden();
      await expect(page.getByRole('button', { name: 'Печать' })).toBeHidden();
      await expect(page.getByTestId('review-sign')).toBeVisible();
      await shot(page, project, 'admin-sign-print');
      await page.emulateMedia({ media: 'screen' });
      const qr = await page.request.get('/api/admin/reviews/qr');
      expect(qr.status()).toBe(200);
      expect(qr.headers()['content-type']).toContain('image/svg+xml');
      expect(qr.headers()['content-disposition']).toContain('review-qr.svg');
    } finally {
      await clearSnapshot(page);
    }
    // Without a snapshot the storefront has no rating line.
    await page.goto('/');
    await expect(page.getByTestId('rating-line')).toHaveCount(0);
  });

  test('«Оцените нас» after the handover; the button opens the card through our redirect', async ({
    page,
  }, testInfo) => {
    test.skip(!PAYMENTS_ON, 'needs the worker and the YooKassa mock: bash scripts/e2e-1c.sh');
    test.setTimeout(300_000);
    const project = testInfo.project.name;
    const before = await openedLast30(page, 'Открыли ссылку на отзыв: Яндекс Карты');
    const token = await handedOrder(page);

    await page.goto(`/o/${token}`);
    await expect(page.getByTestId('order-status')).toHaveText('Выдан');
    const card = page.getByTestId('order-reviews');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Оцените нас');
    await expect(card.getByTestId('order-review-yandex')).toHaveAttribute(
      'href',
      `/o/${token}/review/yandex`,
    );
    await expect(card.getByTestId('order-review-2gis')).toHaveAttribute(
      'href',
      `/o/${token}/review/2gis`,
    );
    await expect(card.getByTestId('order-review-claim')).toHaveAttribute('href', '#claim');
    // Below the claims card (the actions the client may need), above the history.
    const claimsBox = await page.getByTestId('order-claims').boundingBox();
    const cardBox = await card.boundingBox();
    expect(claimsBox && cardBox && cardBox.y > claimsBox.y).toBe(true);
    await expectNoHorizontalScroll(page, '/o/<token> handed with «Оцените нас»');
    await card.screenshot({ path: `test-results/step3/${project}-order-card.png` });
    await shot(page, project, 'order-handed');

    // The redirect itself: 302 to the configured card, private headers.
    const redirect = await page.request.get(`/o/${token}/review/2gis`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers()['location']).toBe(TWO_GIS);
    expect(redirect.headers()['referrer-policy']).toBe('no-referrer');
    expect(redirect.headers()['cache-control']).toBe('no-store');
    expect(redirect.headers()['x-robots-tag']).toContain('noindex');
    const missing = await page.request.get(`/o/${token}/review/google`, { maxRedirects: 0 });
    expect(missing.status()).toBe(404);

    // A tap on «Отзыв в Яндекс Картах» opens our redirect in a new tab. Playwright does not
    // route the hops of a redirect, so the new tab's request to our redirect is passed on to
    // the server by hand (route.fetch without following it: it journals the open and answers
    // 302 to the card) and the tab gets a stub instead of the map service (no network here).
    const redirectPath = `/o/${token}/review/yandex`;
    let seen: { status: number; location: string; referer: string | null } | null = null;
    await page.context().route(`**${redirectPath}`, async (route) => {
      const answer = await route.fetch({ maxRedirects: 0 });
      seen = {
        status: answer.status(),
        location: answer.headers()['location'] ?? '',
        referer: (await route.request().headerValue('referer')) ?? null,
      };
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Карты</p>' });
    });
    // rel="noopener": the new tab is found through the context, not as a popup of this page.
    const opened = page.context().waitForEvent('page');
    await card.getByTestId('order-review-yandex').click();
    const tab = await opened;
    await expect.poll(() => seen).not.toBeNull();
    // The card itself, and the order page's address never travels with the tap.
    expect(seen).toEqual({ status: 302, location: YANDEX, referer: null });
    await tab.close();
    await page.context().unroute(`**${redirectPath}`);

    // The first open of the order on Яндекс Карты is in the funnel (exactly one more).
    expect(await openedLast30(page, 'Открыли ссылку на отзыв: Яндекс Карты')).toBe(before + 1);
  });
});

test.describe('without the review links', () => {
  test.skip(LINKS_ON, 'the links are set: see the other describe');

  test('/review and the redirect answer 404; the admin says the links are not set', async ({
    page,
  }, testInfo) => {
    const project = testInfo.project.name;
    const review = await page.goto('/review');
    expect(review?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
    const token = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';
    const redirect = await page.request.get(`/o/${token}/review/yandex`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(404);
    await page.goto('/admin/reviews');
    await expect(page.getByTestId('reviews-link-yandex')).toHaveAttribute('data-set', 'false');
    await expect(page.getByTestId('reviews-link-2gis')).toHaveAttribute('data-set', 'false');
    await expect(page.getByTestId('reviews-storefront-hidden')).toHaveAttribute(
      'data-reason',
      'no_links',
    );
    await expectNoHorizontalScroll(page, '/admin/reviews without links');
    await shot(page, project, 'admin-reviews-no-links');
    await page.goto('/');
    await expect(page.getByTestId('rating-line')).toHaveCount(0);
  });
});
