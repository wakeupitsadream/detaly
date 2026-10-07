/**
 * Client steps shared by the order specs (not a spec itself): search -> cart -> checkout ->
 * /o/<token>. Offer ids come from the bundled Rossko fixtures (ROSSKO_MODE=fixtures).
 */
import { appendFileSync } from 'node:fs';
import { expect, type Page, type Response } from '@playwright/test';
import { testName, testPhone } from './helpers';

/** Offer ids (OfferView.id = articleNorm:brand:stockId) in the GetSearch fixtures. */
export const KNECHT_LOCAL = 'OC90:Knecht:ORB1';
export const TRW_LOCAL = 'GDB1330:TRW:ORB1';
export const BOSCH_TO_ORDER = '0451103079:BOSCH:MSK7';
/** Engine oil in GetSearch.EDGE5W40: an excluded (marked goods) group. */
export const OIL_EXCLUDED = 'EDGE5W40:CASTROL:ORB1';

export const ORDER_PATH_RE = /^\/o\/[A-Za-z0-9_-]{43}$/;

/** Online payment is switched on (scripts/e2e-1b.sh: YooKassa mock, decision Б6). */
export const PAYMENTS_ON = process.env.E2E_PAYMENTS === 'on';

/**
 * Phones and order tokens a spec used: scripts/e2e-1b.sh greps the web and worker logs for
 * every line of E2E_SECRETS_FILE (counts only). Without the variable nothing is written.
 */
export function rememberSecrets(...values: string[]): void {
  const file = process.env.E2E_SECRETS_FILE;
  if (!file) return;
  const lines = values.filter((v) => v.length >= 4);
  if (lines.length > 0) appendFileSync(file, `${lines.join('\n')}\n`);
}

export interface Client {
  phone: ReturnType<typeof testPhone>;
  name: string;
}

/** A fresh client; the phone (both forms) and the name go to the secrets list. */
export function newClient(): Client {
  const phone = testPhone();
  const name = testName();
  rememberSecrets(phone.e164, phone.national, name);
  return { phone, name };
}

/** "В корзину" on the search row of one offer; the form answers 303 -> /cart?added=1. */
export async function addToCart(page: Page, query: string, offerId: string): Promise<void> {
  await page.goto(`/search?q=${encodeURIComponent(query)}`);
  const form = page
    .getByTestId('add-to-cart')
    .filter({ has: page.locator(`input[name="offerId"][value="${offerId}"]`) });
  await expect(form).toHaveCount(1);
  await form.getByRole('button', { name: /В корзину/ }).click();
  await expect(page).toHaveURL(/\/cart\?added=1$/);
}

/** Changes the quantity of the cart line whose text contains `brand`. */
export async function setCartQty(page: Page, brand: string, qty: number): Promise<void> {
  const line = page.getByTestId('cart-line').filter({ hasText: brand });
  await expect(line).toHaveCount(1);
  await line.getByRole('spinbutton').fill(String(qty));
  await line.getByRole('button', { name: 'Изменить' }).click();
  await expect(line.getByRole('spinbutton')).toHaveValue(String(qty));
}

export function submitButton(page: Page) {
  return page.getByTestId('checkout-form').getByRole('button', { name: 'Оформить заказ' });
}

export async function fillContacts(page: Page, client: Client): Promise<void> {
  await page.getByLabel('Телефон', { exact: true }).fill(client.phone.typed);
  await page.getByLabel('Имя', { exact: true }).fill(client.name);
  // MAX is «скоро» (inactive) as on /vin and the order page: statuses go to Telegram.
  await expect(page.getByRole('radio', { name: /MAX/ })).toBeDisabled();
  // The radio of a ChoiceCard is visually hidden: the card (its label) takes the tap.
  const telegram = page.getByRole('radio', { name: 'Telegram' });
  await page.locator('label', { has: telegram }).click();
  await expect(telegram).toBeChecked();
}

export async function giveConsents(page: Page): Promise<void> {
  await page.getByRole('checkbox', { name: /Принимаю условия/ }).check();
  await page.getByRole('checkbox', { name: /согласие на обработку персональных данных/ }).check();
}

/**
 * Submits the checkout form and waits for the order page document; the access token of the
 * order goes to the secrets list (and to `onToken`).
 */
export async function submitAndOpenOrder(
  page: Page,
  onToken?: (token: string) => void,
): Promise<{ response: Response; token: string }> {
  const orderDocument = page.waitForResponse(
    (r) =>
      r.request().resourceType() === 'document' && ORDER_PATH_RE.test(new URL(r.url()).pathname),
  );
  await submitButton(page).click();
  const response = await orderDocument;
  await expect(page).toHaveURL((url) => ORDER_PATH_RE.test(url.pathname));
  const token = new URL(response.url()).pathname.slice('/o/'.length);
  rememberSecrets(token);
  onToken?.(token);
  expect(response.status()).toBe(200);
  return { response, token };
}

/** The whole cart as one order: /checkout -> contacts and consents -> /o/<token>. */
export async function checkOutCart(
  page: Page,
  client: Client,
  expectedScheme: 'prepay' | 'pay_on_handover',
): Promise<{ token: string; number: string; totalText: string }> {
  await page.goto('/checkout');
  await expect(page.getByTestId('payment-scheme')).toHaveAttribute('data-scheme', expectedScheme);
  const totalText = (await page.getByTestId('checkout-total').textContent())?.trim() ?? '';
  await fillContacts(page, client);
  await giveConsents(page);
  const { token } = await submitAndOpenOrder(page);
  const number = ((await page.getByTestId('order-number').textContent()) ?? '').match(
    /DT-\d{6}/,
  )?.[0];
  expect(number, 'order number on /o/<token>').toBeTruthy();
  return { token, number: number ?? '', totalText };
}
