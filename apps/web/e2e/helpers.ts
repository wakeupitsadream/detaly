/**
 * Shared bits of the e2e specs (not a spec itself: Playwright collects *.spec.ts only).
 */
import { randomInt } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';

/** 198.18.0.0/15 is reserved for benchmarking: never a real client. */
export function randomIp(): string {
  return `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

/** Page width beyond the viewport in px (0 or less: no horizontal scroll). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth;
  });
}

export async function expectNoHorizontalScroll(page: Page, what: string): Promise<void> {
  expect(await horizontalOverflow(page), `${what}: horizontal scroll`).toBeLessThanOrEqual(0);
}

/** Full-page screenshot for a human look: test-results/screens/<project>-<slug>.png. */
export async function screenshot(page: Page, project: string, slug: string): Promise<void> {
  await page.screenshot({ path: `test-results/screens/${project}-${slug}.png`, fullPage: true });
}

/**
 * A fresh mobile number for one test: `national` is the 10-digit DEF number (9xxxxxxxxx),
 * `typed` is how a person writes it ('8 (912) 345-67-89'), `e164` how the server stores it.
 * Unique per run, so orders of parallel or repeated runs never share a user.
 */
export function testPhone(): { national: string; typed: string; e164: string; last4: string } {
  let national = '9';
  for (let i = 0; i < 9; i += 1) national += String(randomInt(0, 10));
  const typed = `8 (${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6, 8)}-${national.slice(8)}`;
  return { national, typed, e164: `+7${national}`, last4: national.slice(-4) };
}

const NAME_LETTERS = 'абвгдежзиклмнопрстуфхцчшэюя';

/** A recognizable, unique client name to grep the server log for. */
export function testName(): string {
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += NAME_LETTERS[randomInt(0, NAME_LETTERS.length)];
  return `Евграф Тест${suffix}`;
}

/**
 * True while the whole element is on screen and clear of the sticky search plate (top 84 px)
 * and the floating bar (bottom 76 px): exactly when HideWhileInView hides the bar. Phones only.
 */
export async function actionClearOnScreen(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const height = (globalThis as unknown as { innerHeight: number }).innerHeight;
    return rect.height > 0 && rect.top >= 84 && rect.bottom <= height - 76;
  });
}

/**
 * Phones: a page with a floating checkout bar always shows a way on — the bar, or the on-page
 * button it repeats, fully visible (never neither, never both).
 */
export async function expectOneCheckoutAction(
  page: Page,
  action: Locator,
  bar: Locator,
): Promise<void> {
  // The observer answers asynchronously after a scroll or a load.
  await expect
    .poll(async () => {
      const clear = await actionClearOnScreen(action);
      return clear !== (await bar.isVisible());
    })
    .toBe(true);
}
