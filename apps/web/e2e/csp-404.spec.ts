/**
 * The script nonce (audit tech-3) and honest not-found pages (perf-11), on mobile 375 and
 * desktop 1280 against the running standalone server:
 *
 * - every page gets its own CSP with 'nonce-…' 'strict-dynamic' and no 'unsafe-inline' in
 *   script-src; every script of the page carries that nonce, the browser refuses nothing and the
 *   page hydrates (a client-side navigation works) — on the storefront, the 404 page and the
 *   admin;
 * - an unknown document (/docs/<unknown>) and a mistyped address answer 404 with a whole page:
 *   «Страница не найдена» in the HTML itself, read without JS and by YandexBot.
 */
import { expect, test, type Page, type Response } from '@playwright/test';
import { randomIp } from './helpers';

test.use({
  // A client ip of its own per test: the searches here never touch another spec's limit.
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
});

const YANDEX_BOT = 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)';
const ADMIN_USER = process.env.E2E_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'e2e-admin-password';

/** The script-src directive of a response's CSP. */
function scriptSrc(response: Response | null): string {
  const csp = response?.headers()['content-security-policy'] ?? '';
  return (
    csp
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src ')) ?? ''
  );
}

/** Messages of the browser refusing something by the page's CSP. */
function watchCsp(page: Page): string[] {
  const refused: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to (load|execute|apply)/i.test(message.text())) {
      refused.push(message.text());
    }
  });
  return refused;
}

/**
 * The response's nonce: script-src has it with 'strict-dynamic' and without 'unsafe-inline', and
 * every <script> of the HTML (Next's bootstrap, chunks and inline data) carries exactly it.
 */
async function expectNonceOnEveryScript(response: Response | null, what: string) {
  const directive = scriptSrc(response);
  expect(directive, what).toMatch(/'nonce-[A-Za-z0-9+/=]{16,}'/);
  expect(directive, what).toContain("'strict-dynamic'");
  expect(directive, what).not.toContain("'unsafe-inline'");
  const nonce = /'nonce-([^']+)'/.exec(directive)?.[1] ?? '';
  const scripts = [...((await response?.text()) ?? '').matchAll(/<script\b[^>]*>/g)].map(
    (match) => match[0],
  );
  expect(scripts.length, what).toBeGreaterThan(0);
  expect(
    scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`)),
    `${what}: every script has the nonce`,
  ).toEqual([]);
  return nonce;
}

test('a new nonce per page, every script carries it, nothing is refused', async ({ page }) => {
  const refused = watchCsp(page);
  const nonces = new Set<string>();
  for (const path of ['/', '/search?q=OC90', '/about', '/docs/offer', '/vin', '/cart']) {
    const response = await page.goto(path, { waitUntil: 'networkidle' });
    expect(response?.status(), path).toBe(200);
    nonces.add(await expectNonceOnEveryScript(response, path));
  }
  expect(nonces.size, 'one nonce per response').toBe(6);
  // The scripts ran: the client router navigates without a full reload.
  await page.goto('/');
  await page.evaluate(() => {
    (window as unknown as { marker: string }).marker = 'same document';
  });
  await page
    .getByRole('navigation', { name: 'Основное меню' })
    .getByRole('link', { name: 'Подбор по VIN' })
    .click();
  await expect(page).toHaveURL(/\/vin$/);
  expect(
    await page.evaluate(() => (window as unknown as { marker?: string }).marker),
    'client-side navigation',
  ).toBe('same document');
  expect(refused).toEqual([]);
});

test('the admin pages run under the nonce too', async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    baseURL,
    httpCredentials: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const page = await context.newPage();
  const refused = watchCsp(page);
  const response = await page.goto('/admin', { waitUntil: 'networkidle' });
  test.skip(response?.status() === 404, 'no ADMIN_BASIC_AUTH on this stand');
  expect(response?.status()).toBe(200);
  await expectNonceOnEveryScript(response, '/admin');
  expect(refused).toEqual([]);
  await context.close();
});

for (const path of ['/docs/nope', '/no-such-page']) {
  test(`${path}: 404 with the whole not-found page, scripts allowed`, async ({ page }) => {
    const refused = watchCsp(page);
    const response = await page.goto(path, { waitUntil: 'networkidle' });
    expect(response?.status()).toBe(404);
    await expect(page).toHaveTitle('Страница не найдена');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Страница не найдена');
    await expectNonceOnEveryScript(response, path);
    expect(refused).toEqual([]);
  });

  test(`${path}: the text is in the HTML for a reader without JS and for YandexBot`, async ({
    request,
  }) => {
    for (const userAgent of [YANDEX_BOT, 'Mozilla/5.0']) {
      const response = await request.get(path, { headers: { 'User-Agent': userAgent } });
      expect(response.status(), userAgent).toBe(404);
      const html = await response.text();
      expect(html, userAgent).not.toContain('id="__next_error__"');
      expect(html, userAgent).toContain('<title>Страница не найдена</title>');
      expect(html, userAgent).toMatch(/<h1[^>]*>Страница не найдена<\/h1>/);
      expect(html, userAgent).toContain('href="/vin"');
    }
  });
}

test.describe('without JS', () => {
  test.use({ javaScriptEnabled: false });

  test('/docs/nope reads as «Страница не найдена» with the way home', async ({ page }) => {
    const response = await page.goto('/docs/nope');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Страница не найдена');
    await expect(page.getByRole('link', { name: 'На главную' })).toBeVisible();
  });
});
