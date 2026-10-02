// DEMO_MODE end to end on the server layer, with the process env of a Vercel demo: no
// DATABASE_URL, no REDIS_URL. Every factory picks its demo implementation, the routes that
// need a database answer 403/404, and nothing reaches Postgres or Redis.
import { resetEnvCache } from '@detaly/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === 'demo_cart' && jar.value !== undefined ? { value: jar.value } : undefined,
    }),
}));

const SECRET = 'test-session-secret-0123456789abcdef';
const saved = { ...process.env };

beforeAll(() => {
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('YOOKASSA_') || key.startsWith('LEGAL_')) delete process.env[key];
  }
  process.env.DEMO_MODE = 'true';
  process.env.SESSION_SECRET = SECRET;
  process.env.ROSSKO_MODE = 'fixtures';
  process.env.LOG_LEVEL = 'silent';
  resetEnvCache();
});

afterAll(() => {
  process.env = { ...saved };
  resetEnvCache();
});

beforeEach(() => {
  jar.value = undefined;
});

describe('DEMO_MODE switch', () => {
  it('is on, and the database and Redis refuse loudly', async () => {
    const { DemoModeError, isDemoMode } = await import('@/server/mode');
    const { getDb } = await import('@/server/db');
    const { getRedis } = await import('@/server/redis');
    expect(isDemoMode()).toBe(true);
    expect(() => getDb()).toThrow(DemoModeError);
    expect(() => getRedis()).toThrow(/redis is not available in DEMO_MODE/);
  });

  it('logs a startup warning', async () => {
    const { startupWarnings } = await import('@/server/startup-checks');
    const { serverEnv } = await import('@/server/env');
    expect(startupWarnings(serverEnv())).toContain('demo_mode');
  });
});

describe('DEMO_MODE factories', () => {
  it('searches the fixtures without search_log', async () => {
    const { getSearchService } = await import('@/server/search');
    const result = await getSearchService().search({ q: 'OC90' });
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.quota).toMatchObject({ breakerOpen: false, exhausted: false });
    const again = await getSearchService().search({ q: 'OC90' });
    expect(again.fromCache).toBe(true);
  });

  it('opens the gate with the bundled documents', async () => {
    const { currentCheckoutGate } = await import('@/server/checkout-gate');
    const gate = await currentCheckoutGate();
    expect(gate.open).toBe(true);
    if (gate.open) {
      expect(gate.docs.offer.kind).toBe('offer');
      expect(gate.docs.consentMarketing?.kind).toBe('consent_marketing');
    }
  });

  it('serves every document page from the bundle', async () => {
    const { DOC_SLUGS, loadPublishedDocument } = await import('@/server/documents');
    for (const kind of [...Object.values(DOC_SLUGS)]) {
      const doc = await loadPublishedDocument(kind);
      expect(doc, kind).not.toBeNull();
      expect(doc?.bodyMd).not.toMatch(/\{\{/);
      expect(doc?.isDraft).toBe(true);
    }
  });

  it('reads the cart and its count from the demo_cart cookie', async () => {
    const { getCartService } = await import('@/server/cart');
    const { requestCartCount } = await import('@/server/cart/count');
    const { encodeDemoCart, newDemoLineId } = await import('@/server/demo/cart-cookie');
    const { getSearchService } = await import('@/server/search');
    expect(await requestCartCount()).toBe(0);
    expect(await getCartService().viewCart(null)).toBeNull();

    const offer = (await getSearchService().search({ q: 'OC90' })).offers.find((o) => !o.excluded);
    expect(offer).toBeDefined();
    jar.value = encodeDemoCart(
      [
        {
          id: newDemoLineId(),
          q: 'OC90',
          offerId: offer!.id,
          qty: Math.max(1, offer!.multiplicity),
        },
      ],
      SECRET,
    );
    const view = await getCartService().viewCart(null);
    expect(view?.lines.map((line) => line.priceClientKop)).toEqual([offer!.priceClientKop]);
    // A page cannot write the cookie.
    await expect(
      getCartService().addItem({ token: null, q: 'OC90', offerId: offer!.id }),
    ).rejects.toThrow(/route handlers/);
  });
});

describe('DEMO_MODE routes', () => {
  it('answers /api/health without checking anything', async () => {
    const { GET } = await import('@/app/api/health/route');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      mode: 'demo',
      db: 'skipped',
      redis: 'skipped',
    });
  });

  it('refuses checkout with 403 demo', async () => {
    const { POST } = await import('@/app/api/checkout/route');
    const response = await POST(
      new Request('http://localhost:3000/api/checkout', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'demo' });
  });

  it('has no webhooks, order API or admin API', async () => {
    const request = () => new Request('http://localhost:3000/x', { method: 'POST', body: '{}' });
    const token = { params: Promise.resolve({ token: 'abcdefghijklmnopqrstuvwxyz' }) };
    const routes = await Promise.all([
      import('@/app/api/webhooks/yookassa/route').then((m) => m.POST(request())),
      import('@/app/api/orders/[token]/cancel/route').then((m) => m.POST(request(), token)),
      import('@/app/api/orders/[token]/pay/route').then((m) => m.POST(request(), token)),
      import('@/app/api/orders/[token]/actions/route').then((m) => m.POST(request(), token)),
      import('@/app/api/admin/orders/[id]/actions/route').then((m) =>
        m.POST(request(), { params: Promise.resolve({ id: '1' }) }),
      ),
    ]);
    for (const response of routes) expect(response.status).toBe(404);
  });

  it('adds to the cart through the route handler', async () => {
    const { getSearchService } = await import('@/server/search');
    const offer = (await getSearchService().search({ q: 'W9142' })).offers.find((o) => !o.excluded);
    expect(offer).toBeDefined();
    const { POST } = await import('@/app/api/cart/items/route');
    const response = await POST(
      new Request('http://localhost:3000/api/cart/items', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ q: 'W9142', offerId: offer!.id }).toString(),
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie().join('\n')).toMatch(/^demo_cart=/m);
  });
});
