/**
 * Step 4 end to end (docs/fit-check.md) on mobile 375x812 and desktop 1280x800.
 *
 *   client: five lines in the cart -> «Проверить под мою машину» on the Knecht search card adds
 *   it and opens the cart with the sheet of its line -> the VIN (typed in lower case with
 *   spaces), a comment, «Все детали корзины» -> «Отправить мастеру» -> every line
 *   «Мастер проверяет»; the master's «Подходит» on Knecht reaches the open cart by itself (the
 *   page refreshes every 30 s);
 *   admin (/admin/fit-checks, the fallback of the seller bot): «Аналог» (MANN-FILTER W914/2),
 *   «Не подходит», «Нужен звонок»; one line expires (moved 25 hours back in the database), one
 *   keeps waiting;
 *   client: every state on the cart -> «Оставить как есть», then «Заменить на аналог» (the line
 *   becomes the analog, checked) -> «Удалить из корзины» on the line that does not fit ->
 *   «Отправить снова» on the expired one -> checkout and the order page show «Проверено
 *   мастером» on the two checked lines.
 *
 * FIT_GUARANTEE_ENABLED decides the guarantee line under the badge and the «Гарантия подбора»
 * section of /returns: scripts/e2e-1c.sh switches it on, scripts/e2e-1b.sh leaves it off, so the
 * two runs cover both. Without JavaScript the form opens inline and posts (303 back), the pending
 * line has «Обновить». The demo (E2E_DEMO_BASE_URL, a DEMO_MODE server) never sends the VIN.
 *
 * Screenshots for a human look: test-results/step4/<project>-*.png.
 */
import { carts, createDb, desc, eq, fitChecks, type Db } from '@detaly/db';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, randomIp } from './helpers';
import {
  addToCart,
  BOSCH_TO_ORDER,
  checkOutCart,
  KNECHT_LOCAL,
  newClient,
  rememberSecrets,
  TRW_LOCAL,
} from './shop';

const ADMIN_USER = process.env.E2E_ADMIN_USER;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? '';
const GUARANTEE = process.env.FIT_GUARANTEE_ENABLED === 'true';
const DEMO_BASE_URL = process.env.E2E_DEMO_BASE_URL ?? null;
const DATABASE_URL = process.env.DATABASE_URL ?? null;

/** Synthetic VIN that passes isValidVin (never a real car); typed the way people type it. */
const VIN = 'XTA21099098765432';
const VIN_TYPED = 'xta 21099 0987 65432';
const COMMENT = 'двигатель 1.6, 2019';

const MAHLE = 'OC90:MAHLE:EKB2';
const LUCAS = 'GDB1330:LUCAS:MSK7';

const GUARANTEE_TEXT = 'Не подойдёт по применимости — вернём деньги';

async function shot(page: Page, project: string, slug: string, full = true): Promise<void> {
  await page.screenshot({ path: `test-results/step4/${project}-${slug}.png`, fullPage: full });
}

async function lineShot(locator: Locator, project: string, slug: string): Promise<void> {
  await locator.screenshot({ path: `test-results/step4/${project}-${slug}.png` });
}

/**
 * The cart line by the text of its heading (brand and article). Not `hasText`: before hydration
 * every line holds the inline form, whose list names the other lines too.
 */
function cartLine(page: Page, text: string): Locator {
  return page
    .getByTestId('cart-line')
    .filter({ has: page.getByRole('heading', { level: 3, name: text }) });
}

function fitOf(line: Locator): Locator {
  return line.getByTestId('fit-line');
}

async function expectTall(locator: Locator, what: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box?.height ?? 0, `${what}: at least 48 px`).toBeGreaterThanOrEqual(48);
}

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

/** The cart of the browser's `cart` cookie (its token goes to the secrets list). */
async function cartIdOf(page: Page): Promise<string> {
  const token = (await page.context().cookies()).find((c) => c.name === 'cart')?.value;
  if (!token) throw new Error('no cart cookie');
  rememberSecrets(token);
  const [row] = await database().select().from(carts).where(eq(carts.anonToken, token));
  if (!row) throw new Error('cart not found');
  return row.id;
}

async function latestRequestId(cartId: string): Promise<string> {
  const [row] = await database()
    .select({ requestId: fitChecks.requestId })
    .from(fitChecks)
    .where(eq(fitChecks.cartId, cartId))
    .orderBy(desc(fitChecks.createdAt))
    .limit(1);
  if (!row) throw new Error('no fit check');
  return row.requestId;
}

/** The latest check of a cart line. */
async function checkIdOf(lineId: string): Promise<string> {
  const [row] = await database()
    .select({ id: fitChecks.id })
    .from(fitChecks)
    .where(eq(fitChecks.cartItemId, lineId))
    .orderBy(desc(fitChecks.createdAt))
    .limit(1);
  if (!row) throw new Error('no fit check of the line');
  return row.id;
}

/** The line id of a cart line (its fit block is `#fit-<line id>`). */
async function lineIdOf(line: Locator): Promise<string> {
  const id = (await fitOf(line).getAttribute('id')) ?? '';
  return id.replace(/^fit-/, '');
}

/** One answer from /admin/fit-checks (303 back with «done»). */
async function adminAnswer(
  page: Page,
  requestId: string,
  brand: string,
  answer: 'Подходит' | 'Не подходит' | 'Нужен звонок' | { analog: string },
): Promise<void> {
  await page.goto('/admin/fit-checks');
  const line = page
    .locator(`[data-request="${requestId}"]`)
    .getByTestId('fit-admin-line')
    .filter({ hasText: brand });
  await expect(line).toHaveCount(1);
  if (typeof answer === 'string') {
    await line.getByRole('button', { name: answer, exact: true }).click();
  } else {
    await line.getByTestId('fit-admin-analog-text').fill(answer.analog);
    await line.getByTestId('fit-admin-analog').click();
  }
  await expect(page.getByTestId('admin-done')).toBeVisible();
}

/** The sheet of a hydrated page: wait until the trigger is the dialog button. */
async function openSheet(line: Locator): Promise<Locator> {
  const trigger = fitOf(line).getByTestId('fit-open');
  await expect(trigger).toHaveAttribute('data-enhanced', 'true');
  await trigger.click();
  const dialog = line.page().locator('dialog[open]');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('fit check: the client, the master and the order', () => {
  test.skip(!ADMIN_USER, 'needs the admin (ADMIN_BASIC_AUTH): bash scripts/e2e-1b.sh or e2e-1c.sh');
  test.skip(!DATABASE_URL, 'needs DATABASE_URL (the expiry is simulated in the database)');

  test.use({
    // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
    extraHTTPHeaders: async ({}, use) => {
      await use({ 'X-Real-IP': randomIp() });
    },
    httpCredentials: { username: ADMIN_USER ?? 'admin', password: ADMIN_PASSWORD },
  });

  test('every line state, the analog, the order with «Проверено мастером»', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const project = testInfo.project.name;
    rememberSecrets(VIN, VIN_TYPED);

    // --- the cart: five lines, then the search card link for Knecht --------------------------
    await addToCart(page, 'OC90', BOSCH_TO_ORDER);
    await addToCart(page, 'OC90', MAHLE);
    await addToCart(page, 'GDB1330', TRW_LOCAL);
    await addToCart(page, 'GDB1330', LUCAS);
    await addToCart(page, 'OC90', 'W71275:MANN-FILTER:ORB1');

    await page.goto('/search?q=OC90');
    const card = page
      .getByTestId('offer-row')
      .filter({ has: page.locator(`input[name="offerId"][value="${KNECHT_LOCAL}"]`) })
      .first();
    const link = card.getByTestId('fit-search');
    await expect(link).toBeVisible();
    await expectTall(link, 'search card link');
    await expectNoHorizontalScroll(page, '/search with the fit link');
    await card.scrollIntoViewIfNeeded();
    await lineShot(card, project, 'search-card-link');
    await link.click();
    await expect(page).toHaveURL(/\/cart\?check=[0-9a-f-]{36}#fit-[0-9a-f-]{36}$/);

    // The sheet of the Knecht line opens by itself, its line ticked.
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    const knecht = cartLine(page, 'Knecht');
    const knechtId = await lineIdOf(knecht);
    await expect(dialog.getByTestId(`fit-line-${knechtId}`)).toBeChecked();
    await expect(dialog.getByTestId('fit-promise')).toContainText(/Мастер проверит|Проверим/);
    await expectNoHorizontalScroll(page, 'the sheet');
    await shot(page, project, 'sheet', false);
    await dialog.getByTestId('fit-vin').fill(VIN_TYPED);
    await dialog.getByTestId('fit-comment').fill(COMMENT);
    await dialog.getByTestId('fit-all').check();
    await expectTall(dialog.getByTestId('fit-submit'), '«Отправить мастеру»');
    await shot(page, project, 'sheet-filled', false);
    await dialog.getByTestId('fit-submit').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-testid="fit-line"][data-state="pending"]')).toHaveCount(6);
    // The focus waits on the line the form was opened from (its new state is read out).
    await expect(fitOf(knecht)).toBeFocused();
    await expect(fitOf(knecht).getByTestId('fit-pending')).toContainText('Мастер проверяет');
    await expectNoHorizontalScroll(page, '/cart pending');
    await shot(page, project, 'cart-pending');

    const cartId = await cartIdOf(page);
    const requestId = await latestRequestId(cartId);

    // --- the master answers Knecht while the cart is open: the page refreshes itself (30 s) ---
    const answered = await page.request.post('/api/admin/fit-checks', {
      form: { action: 'answer', id: await checkIdOf(knechtId), answer: 'fits' },
      headers: { origin: new URL(page.url()).origin },
      maxRedirects: 0,
    });
    expect(answered.status()).toBe(303);
    await expect(fitOf(knecht)).toHaveAttribute('data-state', 'fits', { timeout: 45_000 });

    // --- the rest from the admin; LUCAS expires, MANN W 712/75 keeps waiting ----------------
    await adminAnswer(page, requestId, 'BOSCH', { analog: 'MANN-FILTER W914/2' });
    await adminAnswer(page, requestId, 'MAHLE', 'Не подходит');
    await adminAnswer(page, requestId, 'TRW', 'Нужен звонок');
    await page.goto('/admin/fit-checks');
    await expect(page.locator(`[data-request="${requestId}"]`)).toHaveAttribute(
      'data-waiting',
      'yes',
    );
    await expect(page.getByTestId('fit-stats')).toBeVisible();
    await shot(page, project, 'admin-fit-checks');

    await page.goto('/cart');
    const lucasId = await lineIdOf(cartLine(page, 'LUCAS'));
    // Sent 25 hours ago and expired an hour ago (expires_at stays after created_at, as the
    // database requires): the cart reads the line as expired.
    const sentAt = new Date(Date.now() - 25 * 3_600_000);
    await database()
      .update(fitChecks)
      .set({ createdAt: sentAt, expiresAt: new Date(sentAt.getTime() + 24 * 3_600_000) })
      .where(eq(fitChecks.cartItemId, lucasId));

    // --- every state on the cart -----------------------------------------------------------
    await page.goto('/cart');
    await expect(fitOf(cartLine(page, 'Knecht'))).toHaveAttribute('data-state', 'fits');
    await expect(fitOf(cartLine(page, 'Knecht')).getByTestId('fit-checked')).toHaveText(
      'Проверено мастером',
    );
    if (GUARANTEE) {
      await expect(fitOf(cartLine(page, 'Knecht')).getByTestId('fit-guarantee')).toHaveText(
        GUARANTEE_TEXT,
      );
      await expect(fitOf(cartLine(page, 'Knecht')).getByTestId('fit-guarantee')).toHaveAttribute(
        'href',
        '/returns#fit-guarantee',
      );
    } else {
      // Nothing promises money back for fitment (the supplier-failure refund of the payment
      // notice is another matter).
      await expect(page.getByTestId('fit-guarantee')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText(GUARANTEE_TEXT);
      await expect(page.locator('body')).not.toContainText('по применимости');
    }
    const bosch = fitOf(cartLine(page, 'BOSCH'));
    await expect(bosch).toHaveAttribute('data-state', 'analog_offer');
    await expect(bosch).toContainText(
      /Мастер предлагает аналог: MANN-FILTER W 914\/2 · [\d\s]+₽ · к [а-я]{2} \d{1,2} [а-я]+/u,
    );
    await expectTall(bosch.getByTestId('fit-analog-replace'), '«Заменить»');
    await expectTall(bosch.getByTestId('fit-analog-keep'), '«Оставить как есть»');
    const mahle = fitOf(cartLine(page, 'MAHLE'));
    await expect(mahle).toHaveAttribute('data-state', 'not_fit');
    await expect(mahle).toContainText('Не подходит для вашей машины');
    await expect(mahle.getByRole('link', { name: /Подобрать по VIN/ })).toHaveAttribute(
      'href',
      '/vin',
    );
    const trw = fitOf(cartLine(page, 'TRW'));
    await expect(trw).toHaveAttribute('data-state', 'call_needed');
    await expect(trw).toContainText('Мастеру нужно уточнить — позвоните');
    await expect(trw.getByTestId('fit-call-phone')).toHaveAttribute('href', /^tel:\+?\d+$/);
    const lucas = fitOf(cartLine(page, 'LUCAS'));
    await expect(lucas).toHaveAttribute('data-state', 'expired');
    await expect(lucas).toContainText('Мастер не успел ответить');
    const mann = fitOf(cartLine(page, 'W 712/75'));
    await expect(mann).toHaveAttribute('data-state', 'pending');
    await expectNoHorizontalScroll(page, '/cart with every state');
    await shot(page, project, 'cart-states');
    for (const [text, slug] of [
      ['Knecht', 'line-fits'],
      ['BOSCH', 'line-analog'],
      ['MAHLE', 'line-not-fit'],
      ['TRW', 'line-call'],
      ['LUCAS', 'line-expired'],
      ['W 712/75', 'line-pending'],
    ] as const) {
      await lineShot(cartLine(page, text), project, slug);
    }

    // --- «Оставить как есть», then «Заменить на аналог» -------------------------------------
    await bosch.getByTestId('fit-analog-keep').click();
    await expect(fitOf(cartLine(page, 'BOSCH'))).toHaveAttribute('data-state', 'analog_kept');
    await lineShot(cartLine(page, 'BOSCH'), project, 'line-analog-kept');
    await fitOf(cartLine(page, 'BOSCH')).getByTestId('fit-analog-replace').click();
    await expect(cartLine(page, 'BOSCH')).toHaveCount(0);
    const replaced = cartLine(page, 'W 914/2');
    await expect(fitOf(replaced)).toHaveAttribute('data-state', 'analog_accepted');
    await expect(fitOf(replaced).getByTestId('fit-checked')).toHaveText('Проверено мастером');
    await lineShot(replaced, project, 'line-analog-replaced');

    // --- «Удалить из корзины» on the line that does not fit ---------------------------------
    await expectTall(mahle.getByTestId('fit-remove'), '«Удалить из корзины»');
    await fitOf(cartLine(page, 'MAHLE')).getByTestId('fit-remove').click();
    await expect(cartLine(page, 'MAHLE')).toHaveCount(0);

    // --- «Отправить снова»: the form keeps the VIN of this cart ------------------------------
    const again = await openSheet(cartLine(page, 'LUCAS'));
    await expect(again.getByTestId('fit-vin')).toHaveValue(VIN);
    await again.getByTestId('fit-submit').click();
    await expect(again).toBeHidden();
    await expect(fitOf(cartLine(page, 'LUCAS'))).toHaveAttribute('data-state', 'pending');

    // --- checkout and the order: «Проверено мастером» on the two checked lines --------------
    await page.goto('/checkout');
    const summary = page.getByTestId('checkout-line');
    await expect(summary.filter({ hasText: 'Knecht' }).getByTestId('fit-checked')).toBeVisible();
    await expect(summary.filter({ hasText: 'W 914/2' }).getByTestId('fit-checked')).toBeVisible();
    await expect(page.getByTestId('fit-checked')).toHaveCount(2);
    await expect(page.getByTestId('fit-guarantee')).toHaveCount(GUARANTEE ? 2 : 0);
    await expectNoHorizontalScroll(page, '/checkout with checked lines');
    await shot(page, project, 'checkout');
    const client = newClient();
    await checkOutCart(page, client, 'prepay');
    const items = page.getByTestId('order-item');
    await expect(items.filter({ hasText: 'Knecht' }).getByTestId('fit-checked')).toBeVisible();
    await expect(items.filter({ hasText: 'W 914/2' }).getByTestId('fit-checked')).toBeVisible();
    await expect(page.getByTestId('fit-checked')).toHaveCount(2);
    await expect(page.getByTestId('fit-guarantee')).toHaveCount(GUARANTEE ? 2 : 0);
    await expectNoHorizontalScroll(page, '/o/<token> with checked items');
    await shot(page, project, 'order');

    // The VIN never went into a URL of the client.
    expect(page.url()).not.toContain(VIN);
  });

  test('/returns: «Гарантия подбора» only with FIT_GUARANTEE_ENABLED', async ({
    page,
  }, testInfo) => {
    const response = await page.goto('/returns');
    expect(response?.status()).toBe(200);
    const section = page.locator('#fit-guarantee');
    if (GUARANTEE) {
      await expect(section).toBeVisible();
      await expect(section).toContainText('Гарантия подбора');
      await expect(section).toContainText(
        'Если мастер проверил деталь под ваш VIN, а она не подошла по применимости, вернём деньги полностью',
      );
      await page.goto('/returns#fit-guarantee');
      await expectNoHorizontalScroll(page, '/returns with the guarantee');
      await shot(page, testInfo.project.name, 'returns-guarantee');
    } else {
      await expect(section).toHaveCount(0);
    }
  });
});

test.describe('fit check without JavaScript', () => {
  test.skip(!ADMIN_USER, 'needs the e2e server env: bash scripts/e2e-1b.sh or e2e-1c.sh');
  test.use({
    javaScriptEnabled: false,
    // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
    extraHTTPHeaders: async ({}, use) => {
      await use({ 'X-Real-IP': randomIp() });
    },
  });

  test('the inline form posts, comes back with codes or «Отправили мастеру»', async ({
    page,
  }, testInfo) => {
    const project = testInfo.project.name;
    rememberSecrets(VIN);
    await addToCart(page, 'OC90', KNECHT_LOCAL);
    const line = cartLine(page, 'Knecht');
    const trigger = fitOf(line).getByTestId('fit-open');
    await expectTall(trigger, 'the trigger');
    await trigger.click();
    const panel = fitOf(line).getByTestId('fit-open-panel');
    await expect(panel).toBeVisible();
    await expectNoHorizontalScroll(page, 'the inline form');
    await shot(page, project, 'nojs-form');

    // A VIN with the letter O: back with the hint, the form open, nothing in the URL but a code.
    await panel.getByTestId('fit-vin').fill('XTA2109O098765432');
    await panel.getByTestId('fit-submit').click();
    await expect(page).toHaveURL(/\/cart\?fit_error=vin_oiq&check=[0-9a-f-]{36}#fit-/);
    await expect(fitOf(cartLine(page, 'Knecht')).getByTestId('fit-form-error')).toContainText(
      'В VIN не бывает букв O, I и Q',
    );

    const form = fitOf(cartLine(page, 'Knecht')).getByTestId('fit-open-panel');
    await form.getByTestId('fit-vin').fill(VIN);
    await form.getByTestId('fit-submit').click();
    await expect(page).toHaveURL(/\/cart\?fit=sent#fit-[0-9a-f-]{36}$/);
    await expect(page.getByTestId('fit-sent')).toBeVisible();
    const pending = fitOf(cartLine(page, 'Knecht'));
    await expect(pending).toHaveAttribute('data-state', 'pending');
    const refresh = pending.getByTestId('fit-refresh');
    await expect(refresh).toHaveText('Обновить');
    await expectTall(refresh, '«Обновить»');
    await shot(page, project, 'nojs-pending');
    await refresh.click();
    await expect(page).toHaveURL(/\/cart\?r=\d+#fit-/);
    await expect(fitOf(cartLine(page, 'Knecht'))).toHaveAttribute('data-state', 'pending');
  });
});

test.describe('fit check in the demo', () => {
  test.skip(!DEMO_BASE_URL, 'needs a DEMO_MODE server: E2E_DEMO_BASE_URL');

  /** Every request the page sends, with its body: the VIN must be in none. */
  function recordRequests(page: Page): string[] {
    const sent: string[] = [];
    page.on('request', (request) => {
      sent.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`);
    });
    return sent;
  }

  test('with JavaScript: «Мастер проверяет», then «Проверено мастером · демо»; nothing sent', async ({
    page,
  }, testInfo) => {
    const base = DEMO_BASE_URL ?? '';
    const project = testInfo.project.name;
    await page.goto(`${base}/search?q=OC90`);
    const card = page
      .getByTestId('offer-row')
      .filter({ has: page.locator(`input[name="offerId"][value="${KNECHT_LOCAL}"]`) })
      .first();
    await card.getByTestId('fit-search').click();
    await expect(page).toHaveURL(/\/cart\?check=[0-9a-f-]{36}#fit-/);
    const sent = recordRequests(page);
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Демо: VIN не уйдёт с этой страницы');
    await dialog.getByTestId('fit-vin').fill(VIN_TYPED);
    await shot(page, project, 'demo-sheet', false);
    await dialog.getByTestId('fit-submit').click();
    const line = fitOf(cartLine(page, 'Knecht'));
    await expect(line).toHaveAttribute('data-state', 'pending');
    await expect(line).toHaveAttribute('data-state', 'demo_done', { timeout: 10_000 });
    await expect(line.getByTestId('fit-checked')).toHaveText('Проверено мастером · демо');
    await expectNoHorizontalScroll(page, 'demo /cart');
    await shot(page, project, 'demo-done');
    expect(sent.join('\n')).not.toContain(VIN);
    expect(sent.join('\n').toLowerCase()).not.toContain(VIN_TYPED.replace(/\s/g, '').toLowerCase());
    expect(sent.filter((r) => r.includes('/api/fit-checks'))).toEqual([]);
  });

  test.describe('without JavaScript', () => {
    test.use({ javaScriptEnabled: false });

    test('the form sends only the line; the cart shows the demo answer', async ({ page }) => {
      const base = DEMO_BASE_URL ?? '';
      await page.goto(`${base}/search?q=OC90`);
      const form = page
        .getByTestId('add-to-cart')
        .filter({ has: page.locator(`input[name="offerId"][value="${KNECHT_LOCAL}"]`) });
      await form.getByRole('button', { name: /В корзину/ }).click();
      await expect(page).toHaveURL(/\/cart\?added=1$/);
      const sent = recordRequests(page);
      const line = cartLine(page, 'Knecht');
      await fitOf(line).getByTestId('fit-open').click();
      const panel = fitOf(line).getByTestId('fit-open-panel');
      await panel.getByTestId('fit-vin').fill(VIN);
      await panel.getByTestId('fit-submit').click();
      await expect(page).toHaveURL(/\/cart\?fit_demo=[0-9a-f-]{36}#fit-[0-9a-f-]{36}$/);
      expect(page.url()).not.toContain(VIN);
      await expect(page.getByTestId('fit-demo')).toBeVisible();
      await expect(fitOf(cartLine(page, 'Knecht')).getByTestId('fit-checked')).toHaveText(
        'Проверено мастером · демо',
      );
      expect(sent.join('\n')).not.toContain(VIN);
    });
  });
});
