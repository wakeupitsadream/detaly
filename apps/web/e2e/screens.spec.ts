/**
 * Visits every phase 0 page on mobile (375x812) and desktop (1280x800):
 * no horizontal scroll, the seller INN in the footer, noindex on /search,
 * and a full-page screenshot in test-results/screens/<project>-<slug>.png for a human look.
 */
import { expect, test, type Page } from '@playwright/test';

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
] as const;

/** Exact INN when the runner knows it (E2E_EXPECT_INN), otherwise any 10/12-digit INN. */
const expectedInn = process.env.E2E_EXPECT_INN;
const INN_RE = expectedInn ? new RegExp(`ИНН\\s*${expectedInn}`) : /ИНН\s*(\d{12}|\d{10})\b/;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth;
  });
}

for (const { slug, path } of PAGES) {
  test(`${slug}: layout, requisites, robots`, async ({ page }, testInfo) => {
    const response = await page.goto(path, { waitUntil: 'networkidle' });
    expect(response?.status(), `${path} status`).toBe(200);

    expect(await horizontalOverflow(page), `${path} horizontal scroll`).toBeLessThanOrEqual(0);

    const footer = page.getByTestId('site-footer');
    await expect(footer).toBeVisible();
    await expect(footer.getByTestId('footer-inn')).toHaveText(INN_RE);

    const robots = page.locator('meta[name="robots"]');
    if (path.startsWith('/search')) {
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
