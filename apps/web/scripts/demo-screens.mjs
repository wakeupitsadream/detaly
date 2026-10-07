#!/usr/bin/env node
// Walks the DEMO_MODE storefront like a visitor and saves full-page screenshots at 375 and 1280.
// Start the demo first (docs/demo-vercel.md, «Проверить локально»), then:
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers DEMO_URL=http://127.0.0.1:3101 \
//     node apps/web/scripts/demo-screens.mjs [outDir]
// The flow: home -> search OC90 -> cart (OC90, GDB1330) -> checkout (the form filled with an
// example) -> «Оформить» opens /o/demo -> documents, about, VIN, returns. Also shot: the empty
// cart (before the first «В корзину»), «nothing found» and the sample proposal /p/demo; then every
// page is checked for horizontal scroll at 360 and 1440 as well.
// Default outDir: apps/web/test-results/design-final. Exits 1 on the first failed step.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseURL = process.env.DEMO_URL ?? 'http://127.0.0.1:3101';
const outDir = path.resolve(process.argv[2] ?? path.join(webDir, 'test-results', 'design-final'));

const VIEWPORTS = [
  {
    name: '375',
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  },
  {
    name: '1280',
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
  },
];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function shot(page, vp, name) {
  // Reduced motion is on (see the context), but wait for any CSS animation left anyway, then
  // a beat for the fonts.
  await page.evaluate(() =>
    Promise.all(
      globalThis.document.getAnimations().map((animation) => animation.finished.catch(() => null)),
    ),
  );
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, `${name}-${vp.name}.png`), fullPage: true });
}

async function addToCart(page, query) {
  await page.goto(`/search?q=${query}`);
  const button = page
    .getByTestId('add-to-cart')
    .first()
    .getByRole('button', { name: /В корзину/ });
  await button.click();
  await page.waitForURL(/\/cart\?added=1$/);
}

async function walk(browser, vp) {
  const context = await browser.newContext({
    baseURL,
    viewport: vp.viewport,
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    deviceScaleFactor: vp.deviceScaleFactor,
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    // A full-page capture re-lays the page out at its full height, and Chromium restarts the CSS
    // animations of elements shown from a breakpoint up (`hidden md:block`): the shot then
    // catches the hero half faded and the chain line half drawn. Reduced motion renders the
    // same end state without animating, so the screenshots show the finished page.
    reducedMotion: 'reduce',
    extraHTTPHeaders: { 'X-Real-IP': `198.18.200.${vp.name === '375' ? 1 : 2}` },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  // The empty cart, before anything is added.
  await page.goto('/cart');
  check(await page.getByTestId('cart-empty').isVisible(), 'cart: empty state');
  await shot(page, vp, '00-cart-empty');

  // Home -> search from the header form.
  await page.goto('/');
  check((await page.getByLabel('Артикул детали').count()) === 1, 'home: one search field');
  await shot(page, vp, '01-home');
  await page.getByLabel('Артикул детали').fill('OC90');
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.waitForURL(/\/search\?q=OC90/);
  check((await page.getByTestId('add-to-cart').count()) > 0, 'search OC90: offers');
  await shot(page, vp, '02-search-oc90');

  await page.goto('/search?q=NOTFOUND');
  check((await page.getByTestId('add-to-cart').count()) === 0, 'search NOTFOUND: no offers');
  await shot(page, vp, '03-search-notfound');

  // Two different articles in the cart.
  await page.goto('/search?q=OC90');
  await page
    .getByTestId('add-to-cart')
    .first()
    .getByRole('button', { name: /В корзину/ })
    .click();
  await page.waitForURL(/\/cart\?added=1$/);
  await addToCart(page, 'GDB1330');
  await page.goto('/cart');
  const lines = await page.getByTestId('cart-line').count();
  check(lines === 2, `cart: 2 lines, got ${lines}`);
  await shot(page, vp, '04-cart');

  await page.getByTestId('checkout-link').click();
  await page.waitForURL(/\/checkout$/);
  check(await page.getByTestId('demo-checkout').isVisible(), 'checkout: demo form');
  check(
    (await page.getByLabel('Телефон', { exact: true }).inputValue()) !== '',
    'checkout: demo form is filled with an example',
  );
  await shot(page, vp, '05-checkout');

  // The demo button opens the sample order without any request to /api/checkout (it posts an
  // empty form that only empties the demo cart).
  let posted = false;
  page.on('request', (request) => {
    if (request.url().includes('/api/checkout')) posted = true;
  });
  await page.getByTestId('demo-checkout-submit').click();
  await page.waitForURL(/\/o\/demo$/);
  check(!posted, 'checkout: the demo never posts the form');
  check(await page.getByTestId('order-page').isVisible(), '/o/demo: order page');
  check(
    (await page.getByRole('link', { name: 'Корзина пуста' }).count()) > 0,
    '/o/demo: the demo cart is emptied after «Оформить заказ»',
  );
  await shot(page, vp, '06-order-demo');

  for (const [name, url] of [
    ['07-docs-offer', '/docs/offer'],
    ['08-about', '/about'],
    ['09-vin', '/vin'],
    ['10-returns', '/returns'],
    ['11-proposal-demo', '/p/demo'],
  ]) {
    const response = await page.goto(url);
    check(response?.status() === 200, `${url}: ${response?.status()}`);
    await shot(page, vp, name);
  }

  await checkOverflow(page, vp.name);

  await context.close();
  return errors;
}

const OVERFLOW_PAGES = [
  '/',
  '/search?q=OC90',
  '/search?q=NOTFOUND',
  '/cart',
  '/checkout',
  '/o/demo',
  '/p/demo',
  '/vin',
  '/about',
  '/returns',
  '/docs/offer',
];

/** No horizontal scroll at this width on any storefront page (the cart is filled by then). */
async function checkOverflow(page, width) {
  for (const url of OVERFLOW_PAGES) {
    await page.goto(url);
    // Runs in the browser: `globalThis.document`, since this file is linted as Node code.
    const overflow = await page.evaluate(() => {
      const root = globalThis.document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    check(overflow <= 0, `${url}: horizontal overflow ${overflow}px at ${width}`);
  }
}

/** The edges of the range (docs/design-v2.md, section 5): overflow only, no screenshots. */
async function checkEdges(browser, width) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width, height: 800 },
    isMobile: width < 1024,
    hasTouch: width < 1024,
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    reducedMotion: 'reduce',
    extraHTTPHeaders: { 'X-Real-IP': `198.18.200.${width === 360 ? 3 : 4}` },
  });
  const page = await context.newPage();
  await addToCart(page, 'OC90');
  await checkOverflow(page, String(width));
  await context.close();
}

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
let failed = false;
for (const vp of VIEWPORTS) {
  try {
    const errors = await walk(browser, vp);
    console.log(
      `[demo-screens] ${vp.name}: ok${errors.length ? `, console errors: ${errors.join(' | ')}` : ''}`,
    );
  } catch (error) {
    failed = true;
    console.error(`[demo-screens] ${vp.name}: ${error instanceof Error ? error.message : error}`);
  }
}
for (const width of [360, 1440]) {
  try {
    await checkEdges(browser, width);
    console.log(`[demo-screens] ${width}: no horizontal scroll`);
  } catch (error) {
    failed = true;
    console.error(`[demo-screens] ${width}: ${error instanceof Error ? error.message : error}`);
  }
}
await browser.close();
console.log(`[demo-screens] screenshots in ${outDir}`);
process.exit(failed ? 1 : 0);
