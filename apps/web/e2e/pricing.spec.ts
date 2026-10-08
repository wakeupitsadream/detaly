/**
 * Step 2 end to end (docs/pricing.md) on mobile 375x812 and desktop 1280x800: the owner records
 * a comparison on /admin/prices (the server finds our own price), raises the markup of the
 * filters on /admin/pricing after the preview, the search prices move by exactly the expected
 * amount, and removing the adjustment brings them back. The adjustment is global, so the spec
 * starts and ends with none (also when it fails half way).
 *
 * Needs the admin (ADMIN_BASIC_AUTH): run by scripts/e2e-1b.sh and scripts/e2e-1c.sh.
 * Screenshots for a human look: test-results/step2/<project>-admin-*.png.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, randomIp } from './helpers';
import { KNECHT_LOCAL, TRW_LOCAL } from './shop';

const ADMIN_USER = process.env.E2E_ADMIN_USER;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const KNECHT_TO_ORDER = 'OC90:Knecht:MSK7';

test.skip(!ADMIN_USER, 'needs the admin (ADMIN_BASIC_AUTH): bash scripts/e2e-1b.sh');

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
  httpCredentials: { username: ADMIN_USER ?? 'admin', password: ADMIN_PASSWORD },
});

async function shot(page: Page, project: string, slug: string): Promise<void> {
  await page.screenshot({ path: `test-results/step2/${project}-${slug}.png`, fullPage: true });
}

/** priceClientKop of the offers of a query from GET /api/search (what /search shows). */
async function searchPrices(
  request: APIRequestContext,
  q = 'OC90',
): Promise<Record<string, number>> {
  const response = await request.get(`/api/search?q=${q}`);
  expect(response.status()).toBe(200);
  const { offers } = (await response.json()) as {
    offers: { id: string; priceClientKop: number }[];
  };
  return Object.fromEntries(offers.map((offer) => [offer.id, offer.priceClientKop]));
}

/** Saves the draft currently on /admin/pricing (after «Показать») with the tick. */
async function saveDraft(page: Page): Promise<void> {
  const save = page.getByTestId('pricing-save');
  await expect(save).toBeVisible();
  await save.getByRole('checkbox').check();
  await save.getByRole('button', { name: 'Сохранить поправки' }).click();
  await expect(page).toHaveURL(/\/admin\/pricing\?done=/);
}

/** No adjustments at all: an empty draft, saved when it differs from the current one. */
async function clearAdjustments(page: Page): Promise<void> {
  const response = await page.goto('/admin/pricing?draft=1');
  expect(response?.status()).toBe(200);
  if ((await page.getByTestId('pricing-save').count()) > 0) {
    await saveDraft(page);
    await expect(page.getByTestId('admin-done')).toHaveText('Сохранено: без поправок');
  }
}

test('admin: a price comparison and a group adjustment move the search price exactly', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const project = testInfo.project.name;
  await clearAdjustments(page);
  try {
    // Base table: 412.50 ₽ and 389.00 ₽ wholesale at 28%.
    const before = await searchPrices(page.request);
    expect(before[KNECHT_LOCAL]).toBe(52_800);
    expect(before[KNECHT_TO_ORDER]).toBe(49_800);
    const brakesBefore = await searchPrices(page.request, 'GDB1330');
    expect(brakesBefore[TRW_LOCAL]).toBe(234_800);

    // --- /admin/prices: record a comparison -------------------------------------------------
    const prices = await page.goto('/admin/prices');
    expect(prices?.status()).toBe(200);
    expect(prices?.headers()['x-robots-tag'] ?? '').toContain('noindex');
    const form = page.getByTestId('prices-form');
    await form.getByLabel('Бренд').fill('Knecht');
    await form.getByLabel('Артикул').fill('OC 90');
    await form.getByLabel('Где смотрели').selectOption('emex');
    await form.getByLabel('Цена, ₽').fill('600');
    await form.getByLabel('Доставка до Оренбурга, ₽').fill('0');
    await form.getByLabel('Срок, дней').fill('2');
    await form.getByLabel('Заметка').fill('e2e');
    await form.getByRole('button', { name: 'Записать' }).click();
    await expect(page).toHaveURL(/\/admin\/prices\?done=/);
    // Our cheapest exact offer: Knecht OC 90 to order at 498 ₽.
    await expect(page.getByTestId('admin-done')).toHaveText(
      'Записано: Knecht OC90 — у нас 498\u00a0₽, Emex 600\u00a0₽',
    );
    const row = page.getByTestId('price-row').filter({ hasText: 'e2e' }).first();
    await expect(row).toHaveAttribute('data-group', 'filters');
    await expect(row.getByTestId('price-row-ours')).toContainText('498');
    await expect(page.getByTestId('prices-report').locator('[data-group="filters"]')).toHaveCount(
      1,
    );
    await expectNoHorizontalScroll(page, '/admin/prices');
    await shot(page, project, 'admin-prices');

    // --- /admin/pricing: +3 p.p. in Orenburg, +2 p.p. to order for the filters -------------
    const pricing = await page.goto('/admin/pricing');
    expect(pricing?.status()).toBe(200);
    await expect(page.getByTestId('pricing-base')).toContainText('28%');
    await expectNoHorizontalScroll(page, '/admin/pricing');
    await shot(page, project, 'admin-pricing');

    await page.locator('input[name="l_filters"]').fill('+3');
    await page.locator('input[name="o_filters"]').fill('2');
    await page.getByRole('button', { name: 'Показать, как изменятся цены' }).click();
    await expect(page).toHaveURL(/\/admin\/pricing\?draft=1/);
    const preview = page.getByTestId('pricing-preview');
    await expect(preview.getByTestId('pricing-changes')).toContainText(
      'Фильтры, в Оренбурге: 0 → +3 п.п.',
    );
    // The comparison just recorded is among the examples: 498 ₽ -> 506 ₽.
    const example = preview.getByTestId('pricing-example').filter({ hasText: 'Knecht OC90' });
    await expect(example.first().getByTestId('pricing-example-now')).toContainText('498');
    await expect(example.first().getByTestId('pricing-example-new')).toContainText('506');
    await expectNoHorizontalScroll(page, '/admin/pricing preview');
    await shot(page, project, 'admin-pricing-preview');

    // Saving needs the tick: the browser refuses the form without it.
    await preview.getByRole('button', { name: 'Сохранить поправки' }).click();
    await expect(page).toHaveURL(/\/admin\/pricing\?draft=1/);
    await saveDraft(page);
    await expect(page.getByTestId('admin-done')).toHaveText(
      'Сохранено: Фильтры: в Оренбурге +3, под заказ +2',
    );
    await expect(page.getByTestId('pricing-audit-row').first()).toContainText(
      'без поправок → Фильтры +3 / +2',
    );

    // --- the search follows at once: 412.50 ₽ × 1.31 -> 541 ₽; 389.00 ₽ × 1.30 -> 506 ₽ ------
    const adjusted = await searchPrices(page.request);
    expect(adjusted[KNECHT_LOCAL]).toBe(54_100);
    expect(adjusted[KNECHT_TO_ORDER]).toBe(50_600);
    // other groups are untouched: the brake pads keep their price
    expect(await searchPrices(page.request, 'GDB1330')).toEqual(brakesBefore);
    // the client sees the new price on /search
    await page.goto('/search?q=OC90');
    const local = page
      .getByTestId('offer-row')
      .filter({ has: page.locator(`input[name="offerId"][value="${KNECHT_LOCAL}"]`) });
    await expect(local.getByTestId('offer-price')).toContainText('541');

    // --- removing the adjustment brings the prices back exactly -----------------------------
    await clearAdjustments(page);
    expect(await searchPrices(page.request)).toEqual(before);
  } finally {
    await clearAdjustments(page);
  }
});
