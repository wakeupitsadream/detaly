/**
 * What search engines and messengers read (audit perf-5, perf-2): every public page names the city
 * in its <title>, which ends with the brand from env (the home page too, although the layout's
 * title template does not reach a page of its own segment); its own description, none shared;
 * the Open Graph card with the 1200×630 picture, and no picture behind a token or a cart.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomIp } from './helpers';

test.use({
  // A client ip of its own per test: the searches here never touch another spec's limit.
  // eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Real-IP': randomIp() });
  },
});

async function html(request: APIRequestContext, path: string): Promise<string> {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  return response.text();
}

function meta(page: string, attr: 'name' | 'property', key: string): string | null {
  return new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(page)?.[1] ?? null;
}

test('titles with «Оренбург» end with the brand, descriptions are the pages own', async ({
  request,
}) => {
  const home = await html(request, '/');
  const brand = meta(home, 'property', 'og:site_name');
  expect(brand, 'og:site_name is BRAND_NAME').toBeTruthy();
  const titles: Record<string, string> = {
    '/': 'Автозапчасти в Оренбурге по артикулу и VIN',
    '/vin': 'Подбор запчастей по VIN в Оренбурге',
    '/about': 'О магазине и пункте выдачи в Оренбурге',
    '/returns': 'Возврат и обмен запчастей',
  };
  const descriptions = new Set<string | null>();
  for (const [path, title] of Object.entries(titles)) {
    const page = path === '/' ? home : await html(request, path);
    expect(page, path).toContain(`<title>${title} — ${brand}</title>`);
    const description = meta(page, 'name', 'description');
    expect(description, path).toBeTruthy();
    descriptions.add(description);
    expect(meta(page, 'property', 'og:title'), path).toBe(`${title} — ${brand}`);
    expect(meta(page, 'property', 'og:description'), path).toBe(description);
  }
  expect(descriptions.size, 'no description shared by two pages').toBe(4);
  const search = await html(request, '/search?q=OC90');
  expect(search).toContain(`<title>OC90 — цены и сроки в Оренбурге — ${brand}</title>`);
});

test('the share card: site name, Russian, a website, the picture', async ({ request }) => {
  const home = await html(request, '/');
  expect(meta(home, 'property', 'og:type')).toBe('website');
  expect(meta(home, 'property', 'og:locale')).toBe('ru_RU');
  expect(meta(home, 'property', 'og:image')).toMatch(/^https?:\/\/[^/]+\/images\/og\.png$/);
  expect(meta(home, 'property', 'og:image:width')).toBe('1200');
  expect(meta(home, 'property', 'og:image:height')).toBe('630');
  expect(meta(home, 'name', 'twitter:card')).toBe('summary_large_image');
  const picture = await request.get('/images/og.png');
  expect(picture.status()).toBe(200);
  expect(picture.headers()['content-type']).toBe('image/png');
  for (const path of ['/cart', '/p/demo']) {
    const response = await request.get(path);
    if (response.status() === 404) continue; // /p/demo exists only in the demo
    const page = await response.text();
    expect(meta(page, 'property', 'og:image'), path).toBeNull();
    expect(meta(page, 'name', 'twitter:card'), path).toBe('summary');
    expect(meta(page, 'property', 'og:site_name'), path).toBeTruthy();
  }
});
