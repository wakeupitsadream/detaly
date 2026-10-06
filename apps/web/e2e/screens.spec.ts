/**
 * Visits every phase 0 page and the empty phase 1A cart on mobile (375x812) and desktop
 * (1280x800): no horizontal scroll, the seller INN in the footer, noindex on /search and
 * /cart, and a full-page screenshot in test-results/screens/<project>-<slug>.png for a human
 * look. Filled cart, checkout and order pages are covered by checkout.spec.ts.
 *
 * Phase 1C: /vin (the form when the checkout gate is open), /vin/sent, the sample /p/demo and a
 * real /p/<token> (a VIN request answered through the admin API; only on the 1C stand,
 * scripts/e2e-1c.sh) with noindex and no-referrer.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { horizontalOverflow, randomIp, testPhone } from './helpers';
import { PAYMENTS_ON, rememberSecrets } from './shop';

const PAGES = [
  { slug: 'home', path: '/' },
  { slug: 'search-oc90', path: '/search?q=OC90' },
  { slug: 'search-notfound', path: '/search?q=NOTFOUND' },
  { slug: 'about', path: '/about' },
  { slug: 'docs-offer', path: '/docs/offer' },
  { slug: 'docs-privacy', path: '/docs/privacy' },
  { slug: 'docs-consent', path: '/docs/consent' },
  { slug: 'returns', path: '/returns' },
  { slug: 'vin', path: '/vin' },
  { slug: 'vin-sent', path: '/vin/sent' },
  { slug: 'proposal-demo', path: '/p/demo' },
  { slug: 'cart-empty', path: '/cart' },
] as const;

/** Exact INN when the runner knows it (E2E_EXPECT_INN), otherwise any 10/12-digit INN. */
const expectedInn = process.env.E2E_EXPECT_INN;
const INN_RE = expectedInn ? new RegExp(`ИНН\\s*${expectedInn}`) : /ИНН\s*(\d{12}|\d{10})\b/;

for (const { slug, path } of PAGES) {
  test(`${slug}: layout, requisites, robots`, async ({ page }, testInfo) => {
    const response = await page.goto(path, { waitUntil: 'networkidle' });
    expect(response?.status(), `${path} status`).toBe(200);

    expect(await horizontalOverflow(page), `${path} horizontal scroll`).toBeLessThanOrEqual(0);

    const footer = page.getByTestId('site-footer');
    await expect(footer).toBeVisible();
    await expect(footer.getByTestId('footer-inn')).toHaveText(INN_RE);

    const robots = page.locator('meta[name="robots"]');
    if (path.startsWith('/search') || path === '/cart' || path.startsWith('/p/')) {
      await expect(robots).toHaveAttribute('content', /noindex/);
      expect(response?.headers()['x-robots-tag'] ?? '').toContain('noindex');
    }

    if (slug === 'search-oc90') {
      const rows = page.getByTestId('offer-row');
      expect(await rows.count()).toBeGreaterThan(0);
      await expect(page.getByText('В Оренбурге — оплата при получении').first()).toBeVisible();
      await expect(page.getByText('Под заказ — предоплата').first()).toBeVisible();
      await expect(page.getByTestId('offer-price').first()).toHaveText(/\d\s?₽/);
    }
    if (slug === 'search-notfound') {
      const empty = page.getByTestId('empty-state');
      await expect(empty).toBeVisible();
      await expect(empty.getByRole('link', { name: /VIN/ })).toHaveAttribute('href', '/vin');
    }
    if (slug.startsWith('docs-')) {
      await expect(page.getByTestId('legal-document')).toBeVisible();
      await expect(page.locator('.legal h1, .legal h2').first()).toBeVisible();
    }
    if (slug === 'cart-empty') {
      const empty = page.getByTestId('cart-empty');
      await expect(empty).toBeVisible();
      await expect(empty).toContainText('Корзина пуста');
      await expect(empty.getByRole('link', { name: 'Найти по артикулу' })).toHaveAttribute(
        'href',
        '/',
      );
      await expect(page.getByTestId('checkout-link')).toHaveCount(0);
    }
    if (slug === 'vin') {
      // The 1A/1B stands set RKN_NOTICE_NUMBER: the request form is on.
      await expect(page.getByTestId('vin-form')).toBeVisible();
      await expect(page.getByRole('link', { name: /согласие на обработку/ })).toHaveAttribute(
        'href',
        '/docs/consent',
      );
    }
    if (slug === 'vin-sent') {
      await expect(page.getByTestId('vin-sent-title')).toHaveText('Заявка принята');
    }
    if (slug === 'proposal-demo') {
      expect(response?.headers()['referrer-policy']).toBe('no-referrer');
      await expect(page.getByTestId('proposal-line').first()).toBeVisible();
      await expect(page.getByTestId('proposal-total')).toHaveText(/\d\s?₽/);
    }
    if (slug === 'home') {
      const form = page.locator('form[role="search"]');
      await expect(form).toHaveAttribute('action', '/search');
      await expect(form).toHaveAttribute('method', 'get');
    }

    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}-${slug}.png`,
      fullPage: true,
    });
  });
}

test('/checkout without a cart redirects to the empty cart', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByTestId('cart-empty')).toBeVisible();
  // No personal data field is ever rendered without a cart.
  await expect(page.getByLabel('Телефон', { exact: true })).toHaveCount(0);
});

test.describe('reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('/vin: no frame with a horizontal scroll while the photo input hydrates', async ({
    page,
  }) => {
    // The check after load misses a one-frame overflow: every frame is measured from the start.
    await page.addInitScript(() => {
      const state = globalThis as unknown as { overflowFrames: number };
      state.overflowFrames = 0;
      const tick = () => {
        const root = document.documentElement;
        if (document.body && root.scrollWidth > root.clientWidth) state.overflowFrames += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto('/vin');
    const photos = page.getByTestId('vin-form').locator('input[type="file"]');
    test.skip((await photos.count()) === 0, 'photos are off on this stand (FILES_STORAGE=none)');
    // After hydration PhotoInput hides the plain input (`sr-only`) behind its label button.
    await expect(photos).toHaveClass(/\bsr-only\b/);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const frames = await page.evaluate(
      () => (globalThis as unknown as { overflowFrames: number }).overflowFrames,
    );
    expect(frames, 'frames with a horizontal scroll').toBe(0);
  });
});

test('the search form submits to /search with the query', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Артикул детали').fill('oc 90');
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(page).toHaveURL(/\/search\?q=oc\+90/);
  expect(await page.getByTestId('offer-row').count()).toBeGreaterThan(0);
});

test('"only in Orenburg" shows local offers only', async ({ page }) => {
  await page.goto('/search?q=OC90&local=1');
  const badges = page.getByTestId('stock-badge');
  expect(await badges.count()).toBeGreaterThan(0);
  for (const text of await badges.allTextContents()) {
    expect(text).toBe('В Оренбурге — оплата при получении');
  }
});

test('client-side navigation works through the proxy', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Основное меню' })
    .getByRole('link', { name: 'О нас' })
    .click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('О сервисе');
});

test('robots.txt closes service paths, search is closed by noindex instead', async ({
  request,
}) => {
  const response = await request.get('/robots.txt');
  expect(response.status()).toBe(200);
  const body = await response.text();
  for (const path of ['/o/', '/p/', '/admin']) {
    expect(body).toContain(`Disallow: ${path}`);
  }
  // Disallow would hide the X-Robots-Tag noindex from crawlers
  for (const path of ['/search', '/api/']) {
    expect(body).not.toContain(`Disallow: ${path}`);
  }
  const search = await request.get('/search');
  expect(search.headers()['x-robots-tag'] ?? '').toContain('noindex');
  const api = await request.get('/api/health/live');
  expect(api.headers()['x-robots-tag'] ?? '').toContain('noindex');
});

const ADMIN_USER = process.env.E2E_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'e2e-admin-password';

/**
 * A live proposal without the browser: POST /api/vin (JSON mode), the admin answer and «Отправить
 * клиенту» through /api/admin/vin/<id>/actions. Returns the /p/<token> path.
 */
async function liveProposal(request: APIRequestContext, baseURL: string): Promise<string> {
  const origin = new URL(baseURL).origin;
  const ip = randomIp();
  const page = await request.get('/vin', { headers: { 'X-Real-IP': ip } });
  const html = await page.text();
  const consent = /name="consentPdVersionId" value="([0-9a-f-]{36})"/.exec(html)?.[1] ?? '';
  const requestKey = /name="requestKey" value="([0-9a-f-]{36})"/.exec(html)?.[1] ?? '';
  const phone = testPhone();
  rememberSecrets(phone.e164, phone.national, 'XTA210990Y7654321');
  const sent = await request.post('/api/vin', {
    headers: { Origin: origin, Accept: 'application/json', 'X-Real-IP': ip },
    multipart: {
      vin: 'XTA210990Y7654321',
      need: 'Тормозные колодки передние',
      phone: phone.typed,
      channel: 'sms',
      consentPd: 'on',
      consentPdVersionId: consent,
      requestKey,
      website: '',
    },
  });
  expect(sent.status(), 'POST /api/vin').toBe(200);

  const auth = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64')}`;
  const list = await (
    await request.get('/admin/vin?status=open', { headers: { Authorization: auth } })
  ).text();
  // React separates adjacent text nodes with <!-- --> in server HTML.
  const row =
    list
      .replace(/<!-- -->/g, '')
      .split('<tr')
      .find((part) => part.includes(`•••${phone.last4}`)) ?? '';
  const id = /href="\/admin\/vin\/([0-9a-f-]{36})"/.exec(row)?.[1] ?? '';
  expect(id, 'the request in the admin list').not.toBe('');
  const steps: Record<string, string>[] = [
    { action: 'preview', answer: 'TRW GDB1330 1' },
    { action: 'send' },
  ];
  for (const fields of steps) {
    const answer = await request.post(`/api/admin/vin/${id}/actions`, {
      headers: { Origin: origin, Authorization: auth },
      form: fields,
      maxRedirects: 0,
    });
    expect(answer.status(), fields.action).toBe(303);
  }
  const card = await (
    await request.get(`/admin/vin/${id}`, { headers: { Authorization: auth } })
  ).text();
  const href = /href="(\/p\/[A-Za-z0-9_-]{32})"/.exec(card)?.[1] ?? '';
  expect(href, 'the proposal link').not.toBe('');
  rememberSecrets(href.slice('/p/'.length));
  return href;
}

test('/p/<token>: a live proposal, noindex and no-referrer, no horizontal scroll', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  test.skip(!PAYMENTS_ON, 'needs the 1C stand with the admin: bash scripts/e2e-1c.sh');
  const href = await liveProposal(request, baseURL ?? 'http://127.0.0.1:3100');
  const response = await page.goto(href, { waitUntil: 'networkidle' });
  expect(response?.status()).toBe(200);
  expect(response?.headers()['x-robots-tag'] ?? '').toContain('noindex');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.getByTestId('proposal-line')).toHaveCount(1);
  await expect(page.getByTestId('proposal-take')).toBeVisible();
  if (testInfo.project.name === 'mobile') {
    await expect(page.getByTestId('proposal-bar')).toBeVisible();
  }
  expect(await horizontalOverflow(page), `${href} horizontal scroll`).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}-proposal-live.png`,
    fullPage: true,
  });
});
