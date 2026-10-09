/**
 * Step 6 end to end (docs/garage.md) on mobile 375x812 and desktop 1280x800. The server's
 * GARAGE_ENABLED decides what is checked (scripts/e2e-1c.sh switches it on, scripts/e2e-1b.sh
 * leaves it off):
 *
 *   on:  the checkout has the folded «Моя машина (необязательно)» block → it opens, the car is
 *        typed (make, model, engine, year, VIN, mileage) → a wrong VIN is refused under its field
 *        and no order is made → fixed → the order page says «Для: Lada Vesta 1.6, 2019» → the car
 *        is stored for the client's phone with the order's link; an order with the block left
 *        empty has no car; no horizontal scroll;
 *   off: no block on the checkout, no «Для: …» on the order page, nothing stored even when the
 *        body carries a car.
 *
 * Screenshots for a human look: test-results/step6/<project>-*.png. The VIN is synthetic and goes
 * to the secrets list: the e2e scripts check the logs never carry it.
 */
import { createDb, eq, orders, userVehicles, users, type Db } from '@detaly/db';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, randomIp } from './helpers';
import {
  addToCart,
  fillContacts,
  giveConsents,
  KNECHT_LOCAL,
  newClient,
  ORDER_PATH_RE,
  rememberSecrets,
  submitAndOpenOrder,
  submitButton,
} from './shop';

const GARAGE = process.env.GARAGE_ENABLED === 'true';
const DATABASE_URL = process.env.DATABASE_URL ?? null;
/** Synthetic: valid by ISO 3779 shape only. */
const VIN = 'XTA21099043456789';

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
});

let db: Db | null = null;

function database(): Db {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is needed (scripts/e2e-1b.sh / e2e-1c.sh)');
  db ??= createDb(DATABASE_URL, { max: 1 });
  return db;
}

test.afterAll(async () => {
  await db?.close();
  db = null;
});

async function shot(page: Page, project: string, slug: string): Promise<void> {
  await page.screenshot({ path: `test-results/step6/${project}-${slug}.png` });
}

/** The element alone: on a phone the open block is taller than the screen. */
async function shotOf(locator: Locator, project: string, slug: string): Promise<void> {
  await locator.screenshot({ path: `test-results/step6/${project}-${slug}.png` });
}

async function carsOfPhone(e164: string) {
  const [user] = await database().select().from(users).where(eq(users.phone, e164));
  if (!user) return [];
  return database().select().from(userVehicles).where(eq(userVehicles.userId, user.id));
}

async function orderOfToken(token: string) {
  const [order] = await database().select().from(orders).where(eq(orders.accessToken, token));
  return order;
}

test.describe('«Моя машина» switched on', () => {
  test.skip(!GARAGE, 'GARAGE_ENABLED=true only (bash scripts/e2e-1c.sh)');

  test('the folded block, a car typed, a wrong VIN refused, the order says what car', async ({
    page,
  }, info) => {
    const project = info.project.name;
    rememberSecrets(VIN);
    const client = newClient();
    await addToCart(page, 'OC90', KNECHT_LOCAL);
    await page.goto('/checkout');

    const block = page.getByTestId('checkout-vehicle');
    // Inside the block and exact: the header search box is labelled «Артикул детали или VIN».
    const field = (label: string) => block.getByLabel(label, { exact: true });
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute('data-prefill', 'none');
    await expect(page.getByTestId('checkout-vehicle-summary')).toContainText(
      'Моя машина (необязательно)',
    );
    // Folded: the fields are hidden until the client opens it.
    await expect(field('Марка')).toBeHidden();
    await expectNoHorizontalScroll(page, 'checkout, block folded');
    await block.scrollIntoViewIfNeeded();
    await shot(page, project, 'checkout-garage-collapsed');

    await page.getByTestId('checkout-vehicle-summary').click();
    await expect(field('Марка')).toBeVisible();
    await field('Марка').fill('Lada');
    await field('Модель').fill('Vesta');
    await field('Двигатель').fill('1.6');
    await field('Год выпуска').fill('2019');
    // A letter O where a zero belongs: refused under the field.
    await field('VIN').fill(`${VIN.slice(0, 16)}O`);
    await field('Пробег, км').fill('85 000');
    await expect(page.getByTestId('checkout-vehicle-label')).toHaveText('Lada Vesta 1.6, 2019');
    await expectNoHorizontalScroll(page, 'checkout, block open');
    await shotOf(block, project, 'checkout-garage-expanded');

    await fillContacts(page, client);
    await giveConsents(page);
    await submitButton(page).click();
    await expect(page.getByTestId('checkout-error')).toBeVisible();
    await expect(block).toContainText('В VIN не бывает букв O, I и Q');
    await expect(page).toHaveURL(/\/checkout/);
    expect(await carsOfPhone(client.phone.e164)).toEqual([]);

    await field('VIN').fill(VIN.toLowerCase());
    const { token } = await submitAndOpenOrder(page);
    await expect(page).toHaveURL((url) => ORDER_PATH_RE.test(url.pathname));
    const line = page.getByTestId('order-vehicle');
    await expect(line).toHaveText('Для: Lada Vesta 1.6, 2019');
    // The order page never shows the VIN.
    await expect(page.locator('body')).not.toContainText(VIN);
    await expectNoHorizontalScroll(page, 'order page');
    await line.scrollIntoViewIfNeeded();
    await shot(page, project, 'order-vehicle-line');

    const cars = await carsOfPhone(client.phone.e164);
    expect(cars).toHaveLength(1);
    expect(cars[0]).toMatchObject({
      make: 'Lada',
      model: 'Vesta',
      engine: '1.6',
      year: 2019,
      vin: VIN,
      mileageKm: 85_000,
      source: 'checkout',
    });
    expect((await orderOfToken(token))?.vehicleId).toBe(cars[0]?.id);
  });

  test('the block left empty: an order without a car', async ({ page }) => {
    const client = newClient();
    await addToCart(page, 'OC90', KNECHT_LOCAL);
    await page.goto('/checkout');
    await expect(page.getByTestId('checkout-vehicle')).toBeVisible();
    await fillContacts(page, client);
    await giveConsents(page);
    const { token } = await submitAndOpenOrder(page);
    await expect(page.getByTestId('order-vehicle')).toHaveCount(0);
    expect((await orderOfToken(token))?.vehicleId).toBeNull();
    expect(await carsOfPhone(client.phone.e164)).toEqual([]);
  });
});

test.describe('«Моя машина» switched off', () => {
  test.skip(GARAGE, 'GARAGE_ENABLED=false only (bash scripts/e2e-1b.sh)');

  test('no block, no line, nothing stored even when the body carries a car', async ({ page }) => {
    rememberSecrets(VIN);
    const client = newClient();
    await addToCart(page, 'OC90', KNECHT_LOCAL);
    await page.goto('/checkout');
    await expect(page.getByTestId('checkout-form')).toBeVisible();
    await expect(page.getByTestId('checkout-vehicle')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Моя машина');

    // A forged body with a car: the server never reads it.
    await page.route('**/api/checkout', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await route.continue({
        postData: JSON.stringify({
          ...body,
          vehicle: { make: 'Lada', model: 'Vesta', vin: VIN, mileage: '1000' },
        }),
      });
    });
    await fillContacts(page, client);
    await giveConsents(page);
    const { token } = await submitAndOpenOrder(page);
    await expect(page.getByTestId('order-vehicle')).toHaveCount(0);
    expect((await orderOfToken(token))?.vehicleId).toBeNull();
    expect(await carsOfPhone(client.phone.e164)).toEqual([]);
  });
});
