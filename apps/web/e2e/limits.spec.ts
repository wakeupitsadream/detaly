/**
 * Rate limits through the real proxy: 20 searches per minute pass, the 21st gets 429
 * (JSON with Retry-After on /api/search, HTML on /search); the 11th POST /api/checkout in an
 * hour gets 429. Needs the server started with TRUSTED_IP_HEADER=x-real-ip; each test uses a
 * fresh random client ip.
 */
import { expect, test } from '@playwright/test';
import { randomIp } from './helpers';

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

  test('HEAD and router prefetches are not counted', async ({ request }) => {
    const headers = { 'X-Real-IP': randomIp() };
    for (let i = 0; i < 25; i += 1) {
      // Answered by the proxy itself: no search runs, nothing is counted.
      const head = await request.head('/search?q=OC90', { headers });
      expect(head.status()).toBe(200);
      const apiHead = await request.head('/api/search?q=OC90', { headers });
      expect(apiHead.status()).toBe(200);
      // A genuine App Router prefetch renders no page data. maxRedirects 0: Next may answer
      // 307 to add its cache-busting `_rsc` parameter.
      const prefetch = await request.get('/search?q=OC90', {
        headers: { ...headers, RSC: '1', 'Next-Router-Prefetch': '1' },
        maxRedirects: 0,
      });
      expect(prefetch.status()).not.toBe(429);
    }
    const real = await request.get('/api/search?q=OC90', { headers });
    expect(real.status()).toBe(200);
  });

  test('spoofed prefetch hints and other methods are counted', async ({ request }) => {
    const headers = { 'X-Real-IP': randomIp() };
    const spoofed: Record<string, string>[] = [
      { 'Next-Router-Prefetch': '1' },
      { Purpose: 'prefetch' },
      { 'Sec-Purpose': 'prefetch' },
    ];
    for (let i = 0; i < 20; i += 1) {
      const extra = spoofed[i % spoofed.length];
      const path = i % 2 === 0 ? '/api/search?q=OC90' : '/search?q=OC90';
      const response =
        i % 5 === 4
          ? await request.post('/search?q=OC90', { headers })
          : await request.get(path, { headers: { ...headers, ...extra } });
      expect(response.status(), `request ${i + 1}`).not.toBe(429);
    }
    const blocked = await request.get('/api/search?q=OC90', {
      headers: { ...headers, Purpose: 'prefetch' },
    });
    expect(blocked.status()).toBe(429);
  });
});

test.describe('checkout rate limit', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop project only');

  test('11th POST /api/checkout in an hour gets 429 before the handler', async ({ request }) => {
    const headers = { 'X-Real-IP': randomIp(), 'Content-Type': 'application/json' };
    // The proxy counts before the handler, so an invalid body is enough: no order, no cart.
    for (let i = 1; i <= 10; i += 1) {
      const response = await request.post('/api/checkout', { headers, data: '{}' });
      expect(response.status(), `request ${i}`).not.toBe(429);
    }
    const blocked = await request.post('/api/checkout', { headers, data: '{}' });
    expect(blocked.status()).toBe(429);
    const retryAfter = Number(blocked.headers()['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' });

    // Reading is not limited: the search of the same client still works.
    const search = await request.get('/api/search?q=OC90', {
      headers: { 'X-Real-IP': headers['X-Real-IP'] },
    });
    expect(search.status()).toBe(200);
    // Another client is not affected.
    const other = await request.post('/api/checkout', {
      headers: { ...headers, 'X-Real-IP': randomIp() },
      data: '{}',
    });
    expect(other.status()).not.toBe(429);
  });
});
