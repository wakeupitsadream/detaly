/**
 * Search rate limit through the real proxy: 20 searches per minute pass, the 21st gets 429
 * (JSON with Retry-After on /api/search, HTML on /search). Needs the server started with
 * TRUSTED_IP_HEADER=x-real-ip; each test uses a fresh random client ip.
 */
import { randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';

function randomIp(): string {
  // 198.18.0.0/15 is reserved for benchmarking: never a real client.
  return `198.19.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

test.describe('search rate limit', () => {
  // Once per run is enough; the limit does not depend on the viewport.
  test.skip(({ isMobile }) => isMobile, 'desktop project only');

  test('21st search in a minute gets 429 with Retry-After', async ({ request }) => {
    const headers = { 'X-Real-IP': randomIp() };
    for (let i = 1; i <= 20; i += 1) {
      const response = await request.get('/api/search?q=OC90', { headers });
      expect(response.status(), `request ${i}`).toBe(200);
    }
    const blocked = await request.get('/api/search?q=OC90', { headers });
    expect(blocked.status()).toBe(429);
    const retryAfter = Number(blocked.headers()['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' });

    // The same client is blocked on the HTML page too.
    const page = await request.get('/search?q=OC90', { headers });
    expect(page.status()).toBe(429);
    expect(page.headers()['content-type']).toContain('text/html');
    expect(await page.text()).toContain('Слишком много запросов');
  });

  test('HEAD and prefetch requests are not counted', async ({ request }) => {
    const headers = { 'X-Real-IP': randomIp() };
    for (let i = 0; i < 25; i += 1) {
      const head = await request.head('/search?q=OC90', { headers });
      expect(head.status()).toBe(200);
      const prefetch = await request.get('/search?q=OC90', {
        headers: { ...headers, 'Next-Router-Prefetch': '1' },
      });
      expect(prefetch.status()).not.toBe(429);
    }
    const real = await request.get('/api/search?q=OC90', { headers });
    expect(real.status()).toBe(200);
  });
});
