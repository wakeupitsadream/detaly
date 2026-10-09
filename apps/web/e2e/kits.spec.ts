/**
 * Step 5 end to end (docs/kits.md) on mobile 375x812 and desktop 1280x800.
 *
 *   admin (/admin/kits): «Новый набор» → the lines in the VIN-answer format with alternatives
 *   «или …» and one marked good → «Проверить» (found / marked goods, the sum) → «Сохранить» →
 *   «Опубликовать» is refused for the marked good → the line removed → «Сохранить» →
 *   «Опубликовать»;
 *   storefront: the make tile of the home page leads to the kits → /to → /to/<make> → the kit
 *   page (live prices, the oil sentence, the replacement time, no horizontal scroll, buttons of
 *   48 px) → the alternative of the oil filter chosen (the sum follows) → «Весь набор в корзину»
 *   → the cart with the kit's lines; without JavaScript the same form posts the default choice.
 *
 * The demo (E2E_DEMO_BASE_URL, a DEMO_MODE server) shows the labelled samples, its button fills
 * the demo cart and its /admin/kits is 404. Every kit of the e2e database is removed before and
 * after (other specs see the home page without kits): a published one is first taken off the
 * site through the admin, which also drops the server's cached kit list (60 s otherwise).
 *
 * Screenshots for a human look: test-results/step5/<project>-*.png.
 */
import { createDb, eq, kits, type Db } from '@detaly/db';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, randomIp } from './helpers';

const ADMIN_USER = process.env.E2E_ADMIN_USER;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const DEMO_BASE_URL = process.env.E2E_DEMO_BASE_URL ?? null;
const DATABASE_URL = process.env.DATABASE_URL ?? null;

const LINES = [
  'MANN W914/2 1 — Фильтр масляный',
  'или KNECHT OC90',
  'MANN C26003 1',
  'MANN CU1919 1 — Фильтр салонный',
  'NGK BKR6E 4 — Свечи зажигания',
  'или BOSCH FR7DCX+',
].join('\n');
const WITH_OIL = `${LINES}\nCASTROL EDGE5W40 1 — Масло моторное`;

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
});

async function shot(page: Page, project: string, slug: string, full = true): Promise<void> {
  await page.screenshot({ path: `test-results/step5/${project}-${slug}.png`, fullPage: full });
}

async function expectTall(locator: Locator, what: string, min = 48): Promise<void> {
  const box = await locator.boundingBox();
  expect(box?.height ?? 0, `${what}: at least ${min} px`).toBeGreaterThanOrEqual(min);
}

let db: Db | null = null;

function database(): Db {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is needed (scripts/e2e-1b.sh / e2e-1c.sh)');
  db ??= createDb(DATABASE_URL, { max: 1 });
  return db;
}

/**
 * Removes every kit: the published ones are taken off the site through the admin first (that
 * drops the web server's cached list of published kits), then the rows go.
 */
async function removeKits(request: APIRequestContext, baseURL: string | undefined): Promise<void> {
  const published = await database()
    .select({ id: kits.id, updatedAt: kits.updatedAt })
    .from(kits)
    .where(eq(kits.status, 'published'));
  for (const kit of published) {
    const response = await request.post('/api/admin/kits', {
      form: { action: 'unpublish', id: kit.id, version: kit.updatedAt.toISOString() },
      headers: { Origin: new URL(baseURL ?? 'http://127.0.0.1:3100').origin },
      maxRedirects: 0,
    });
    expect(response.status(), 'unpublish through the admin').toBe(303);
  }
  await database().delete(kits);
}

test.describe('maintenance kits', () => {
  test.skip(!ADMIN_USER, 'needs the admin (ADMIN_BASIC_AUTH): bash scripts/e2e-1b.sh');
  test.use({ httpCredentials: { username: ADMIN_USER ?? 'admin', password: ADMIN_PASSWORD } });

  test.beforeEach(async ({ request, baseURL }) => {
    await removeKits(request, baseURL);
  });

  test.afterAll(async ({ request, baseURL }) => {
    if (DATABASE_URL) await removeKits(request, baseURL);
    await db?.close();
    db = null;
  });

  /**
   * The admin makes and publishes the Vesta kit (the refused try with a marked good first);
   * screenshots when `project` is given.
   */
  async function publishKit(page: Page, project: string | null): Promise<void> {
    const list = await page.goto('/admin/kits');
    expect(list?.status()).toBe(200);
    expect(list?.headers()['x-robots-tag'] ?? '').toContain('noindex');
    await page.getByTestId('kit-new').click();
    await expect(page).toHaveURL(/\/admin\/kits\/new$/);
    await page.getByTestId('kit-make').selectOption('lada');
    await page.getByTestId('kit-model').fill('Vesta');
    await page.getByTestId('kit-engine').fill('1.6 16V, 106 л.с.');
    await page.getByTestId('kit-years-from').fill('2015');
    await page.getByTestId('kit-note').fill('замена ≈ 1 ч');
    await page.getByTestId('kit-lines').fill(WITH_OIL);

    await page.getByTestId('kit-check-button').click();
    await expect(page).toHaveURL(/\/admin\/kits\/new\?.*check=1/);
    const check = page.getByTestId('kit-check');
    await expect(check.getByTestId('kit-check-line')).toHaveCount(7);
    await expect(check.locator('[data-testid="kit-check-line"][data-state="ok"]')).toHaveCount(6);
    await expect(
      check.locator('[data-testid="kit-check-line"][data-state="excluded"]'),
    ).toHaveCount(1);
    // no role typed: the supplier's name of the part
    await expect(check.getByTestId('kit-check-line').nth(2)).toContainText('Фильтр воздушный');
    await expect(page.getByTestId('kit-check-problems')).toContainText(
      'Строка 7: маркируемый товар — в набор нельзя',
    );
    // the draft is still in the form
    await expect(page.getByTestId('kit-lines')).toHaveValue(WITH_OIL);
    await expectNoHorizontalScroll(page, '/admin/kits/new check');

    await page.getByTestId('kit-save').click();
    await expect(page).toHaveURL(/\/admin\/kits\/[0-9a-f-]{36}\?done=/);
    await expect(page.getByTestId('admin-done')).toHaveText('Сохранено');
    await page.getByTestId('kit-publish').click();
    await expect(page.getByTestId('admin-kit-error')).toHaveText(
      'Не опубликовано: Строка 7: маркируемый товар — в набор нельзя',
    );

    await page.getByTestId('kit-lines').fill(LINES);
    await page.getByTestId('kit-save').click();
    await expect(page.getByTestId('admin-done')).toHaveText('Сохранено');
    await expect(page.getByTestId('kit-check-ok')).toBeVisible();
    await expect(page.getByTestId('kit-check-total')).toHaveText('4 052 ₽');
    await expectNoHorizontalScroll(page, '/admin/kits/<id>');
    if (project) await shot(page, project, 'admin-kit-edit');
    await page.getByTestId('kit-publish').click();
    await expect(page.getByTestId('admin-done')).toHaveText('Опубликовано: /to/lada/vesta#1-6-16v');
    await expect(page.getByTestId('kit-status')).toHaveAttribute('data-status', 'published');

    await page.goto('/admin/kits');
    const rows = page.getByTestId('kit-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-status', 'published');
    await expect(rows.first().getByTestId('kit-row-link')).toHaveText('Lada Vesta');
    await expect(rows.first().getByTestId('kit-row-lines')).toHaveText('4 позиции + 2 аналога');
    await expectNoHorizontalScroll(page, '/admin/kits');
    if (project) await shot(page, project, 'admin-kits');
  }

  test('admin publishes a kit; the client takes it whole with an alternative', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const project = testInfo.project.name;
    await publishKit(page, project);

    // The check of the draft, for the screenshot with the preview.
    await page.goto(
      `/admin/kits/new?check=1&make=lada&model=Vesta&engine=${encodeURIComponent('1.6 16V, 106 л.с.')}&years_from=2015&lines=${encodeURIComponent(WITH_OIL)}`,
    );
    await expect(page.getByTestId('kit-check-line')).toHaveCount(7);
    await shot(page, project, 'admin-kit-check');

    // --- the home tile of the make leads to its kits ----------------------------------------
    await page.goto('/');
    await expect(page.getByTestId('home-brand-lada')).toHaveAttribute('href', '/to/lada');
    await expect(page.getByTestId('home-brand-kia')).toHaveAttribute('href', /^\/vin\?car=Kia$/);
    await expect(page.getByTestId('home-brands-hint')).toContainText('готовые наборы для ТО');
    await expect(
      page.getByTestId('site-footer').getByRole('link', { name: 'Наборы для ТО' }),
    ).toHaveAttribute('href', '/to');

    // --- /to and /to/lada -------------------------------------------------------------------
    const index = await page.goto('/to');
    expect(index?.status()).toBe(200);
    await expect(page.getByTestId('kits-title')).toHaveText('Наборы для ТО');
    await expect(page.getByTestId('kit-make-lada')).toBeVisible();
    await expect(page.getByTestId('kit-make-hyundai')).toHaveCount(0);
    await expectNoHorizontalScroll(page, '/to');
    await shot(page, project, 'to');
    await page.getByTestId('kit-make-lada').click();
    await expect(page).toHaveURL(/\/to\/lada$/);
    await expect(page.getByTestId('kit-make-title')).toHaveText('ТО Lada');
    await expectNoHorizontalScroll(page, '/to/lada');
    await shot(page, project, 'to-lada');
    await page.getByTestId('kit-model-vesta').click();
    await expect(page).toHaveURL(/\/to\/lada\/vesta$/);
    await expect(page).toHaveTitle(/^ТО Lada Vesta в Оренбурге — набор запчастей — /);

    // --- the kit page -------------------------------------------------------------------------
    const section = page.getByTestId('kit-section');
    await expect(section).toHaveCount(1);
    await expect(section.getByTestId('kit-title')).toHaveText('ТО Lada Vesta 1.6 16V, 106 л.с.');
    await expect(section.getByTestId('kit-demo-label')).toHaveCount(0);
    await expect(section.getByTestId('kit-line')).toHaveCount(4);
    await expect(section.getByTestId('kit-total')).toHaveText('4 052 ₽');
    await expect(section.getByTestId('kit-oil')).toContainText(
      'Масло и антифриз в набор не входят — их подберут и зальют в автосервисе при пункте выдачи по его прайсу',
    );
    await expect(section.getByTestId('kit-install')).toContainText(
      'Замена ≈ 1 ч — можно записаться на установку после оформления',
    );
    await expect(section.getByTestId('kit-fit-hint')).toHaveText(
      'Не уверены? В корзине нажмите «Проверить под мою машину»',
    );
    const add = section.getByTestId('kit-add');
    await expectTall(add, '«Весь набор в корзину»');
    await expectTall(section.getByTestId('kit-option').first(), 'a choice', 44);
    await expectNoHorizontalScroll(page, '/to/lada/vesta');
    await shot(page, project, 'kit');

    // The alternative of the oil filter: Knecht OC 90, 270 ₽ cheaper; the sum follows.
    const alternative = section.getByTestId('kit-option').filter({ hasText: 'Knecht' }).first();
    await expect(alternative.getByTestId('kit-option-hint')).toHaveText(
      'дешевле на 270 ₽ · быстрее',
    );
    await alternative.click();
    await expect(alternative.locator('input[type="radio"]')).toBeChecked();
    await expect(section.getByTestId('kit-total')).toHaveText('3 782 ₽');
    await shot(page, project, 'kit-alternative', false);

    await add.click();
    await expect(page).toHaveURL(/\/cart\?kit=4&kit_skipped=0$/);
    await expect(page.getByTestId('cart-kit-added')).toContainText('Добавили 4 позиции');
    const lines = page.getByTestId('cart-line');
    await expect(lines).toHaveCount(4);
    // The chosen alternative instead of the main line, by the lines' own titles (the fit form of
    // a line lists every part of the cart).
    const titles = lines.getByRole('heading', { level: 3 });
    await expect(titles.filter({ hasText: /^Knecht OC 90$/i })).toHaveCount(1);
    await expect(titles.filter({ hasText: /W 914\/2/ })).toHaveCount(0);
    await expect(
      lines.filter({ has: page.getByRole('heading', { name: /BKR6E/ }) }).getByRole('spinbutton'),
    ).toHaveValue('4');
    await expectNoHorizontalScroll(page, '/cart after the kit');
    await shot(page, project, 'cart-kit');
  });

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false });

    test('the admin and the kit form work; the form posts the default choice', async ({ page }) => {
      test.setTimeout(120_000);
      await publishKit(page, null);
      await page.goto('/to/lada/vesta');
      const section = page.getByTestId('kit-section');
      await expect(section.getByTestId('kit-total')).toHaveText('4 052 ₽');
      await section.getByTestId('kit-add').click();
      await expect(page).toHaveURL(/\/cart\?kit=4&kit_skipped=0$/);
      const titles = page.getByTestId('cart-line').getByRole('heading', { level: 3 });
      await expect(titles).toHaveCount(4);
      await expect(titles.filter({ hasText: /W 914\/2/ })).toHaveCount(1);
      await expect(titles.filter({ hasText: /Knecht/i })).toHaveCount(0);
    });
  });

  test('a draft model and an unknown make are 404; the admin list needs the password', async ({
    page,
    baseURL,
  }) => {
    // A draft of the Vesta: never on the site.
    await database().insert(kits).values({
      makeSlug: 'lada',
      model: 'Vesta',
      modelSlug: 'vesta',
      engine: '1.6 16V, 106 л.с.',
      yearsFrom: 2015,
      slug: '1-6-16v',
      status: 'draft',
      createdBy: 'e2e',
      updatedBy: 'e2e',
    });
    for (const path of ['/to/lada/vesta', '/to/lada', '/to/zaz/vesta', '/to/lada/vesta-x']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Набор не найден');
    }
    const index = await page.goto('/to');
    expect(index?.status()).toBe(200);
    await expect(page.getByTestId('kit-make-lada')).toHaveCount(0);
    const sitemap = await page.request.get('/sitemap.xml');
    expect(await sitemap.text()).not.toContain('/to');
    // Plain fetch: every Playwright context of this file carries the admin credentials.
    const admin = await fetch(new URL('/admin/kits', baseURL).toString(), {
      headers: { 'X-Real-IP': randomIp() },
      redirect: 'manual',
    });
    expect(admin.status).toBe(401);
  });
});

test.describe('maintenance kits in the demo', () => {
  test.skip(!DEMO_BASE_URL, 'needs a DEMO_MODE server: E2E_DEMO_BASE_URL');

  test('the labelled samples, the demo cart, no admin', async ({ page }, testInfo) => {
    const base = DEMO_BASE_URL ?? '';
    const project = testInfo.project.name;
    for (const path of ['/to', '/to/lada', '/to/hyundai']) {
      const response = await page.goto(`${base}${path}`);
      expect(response?.status(), path).toBe(200);
      await expect(page.getByTestId('kit-demo-label').first()).toBeVisible();
      await expectNoHorizontalScroll(page, `demo ${path}`);
    }
    await page.goto(`${base}/`);
    await expect(page.getByTestId('home-brand-lada')).toHaveAttribute('href', '/to/lada');
    const response = await page.goto(`${base}/to/lada/vesta`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['x-robots-tag'] ?? '').toContain('noindex');
    // the label in the title area and on the kit section
    await expect(page.getByTestId('kit-demo-label')).toHaveCount(2);
    await expect(page.getByTestId('kit-demo-label').first()).toHaveText(
      'Пример набора — состав для демонстрации, не для покупки',
    );
    await expectNoHorizontalScroll(page, 'demo /to/lada/vesta');
    await shot(page, project, 'demo-kit');
    await page.getByTestId('kit-add').click();
    await expect(page).toHaveURL(/\/cart\?kit=4&kit_skipped=0$/);
    await expect(page.getByTestId('cart-line')).toHaveCount(4);
    await shot(page, project, 'demo-cart-kit');
    const admin = await page.request.get(`${base}/admin/kits`);
    expect(admin.status()).toBe(404);
    const robots = await page.request.get(`${base}/robots.txt`);
    expect(await robots.text()).toMatch(/Disallow: \/\s*$/m);
  });
});
