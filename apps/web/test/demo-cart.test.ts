// The demo cart (DEMO_MODE): the signed demo_cart cookie, DemoCartService over the fixtures and
// the live /api/cart handlers running on it. No database and no Redis.
import { parseEnv, type Env } from '@detaly/config';
import { MAX_ORDER_TOTAL_KOP, type OfferView } from '@detaly/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_CART_LINES } from '@/server/cart-store';
import { handleAddItem, handleLineRequest } from '@/server/cart/http';
import {
  DEMO_CART_COOKIE,
  decodeDemoCart,
  demoCartSetCookie,
  encodeDemoCart,
  newDemoLineId,
  type DemoCartLine,
} from '@/server/demo/cart-cookie';
import { handleDemoCartRequest, type DemoCartRequestDeps } from '@/server/demo/cart-http';
import { createDemoCartService, type DemoCartJar } from '@/server/demo/cart-service';
import { createDemoSupplier } from '@/server/demo/supplier';
import { demoSearchDeps } from '@/server/search';
import { createSearchService } from '@/server/search-service';
import type { Supplier } from '@/server/supplier';

const SECRET = 'test-session-secret-0123456789abcdef';
const ORIGIN = 'http://localhost:3000';

function demoEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({ SESSION_SECRET: SECRET, DEMO_MODE: 'true', ...overrides });
}

let env: Env;
let supplier: Supplier;
let oc90: OfferView[];

beforeAll(async () => {
  env = demoEnv();
  supplier = createDemoSupplier({ env });
  const search = createSearchService(demoSearchDeps(supplier));
  oc90 = (await search.search({ q: 'OC90' })).offers;
});

function sellable(): OfferView[] {
  return oc90.filter((offer) => !offer.excluded);
}

function memoryJar(initial: DemoCartLine[] = []) {
  const box = { lines: initial, writes: 0 };
  const jar: DemoCartJar = {
    read: () => Promise.resolve(box.lines.map((line) => ({ ...line }))),
    write: (lines) => {
      box.lines = lines;
      box.writes += 1;
    },
  };
  return { jar, box };
}

function service(jar: DemoCartJar) {
  return createDemoCartService({
    jar,
    supplier,
    loadSettings: () => supplier.settings.get(),
  });
}

describe('demo_cart cookie', () => {
  const line: DemoCartLine = {
    id: newDemoLineId(),
    q: 'OC90',
    offerId: 'OC90:KNECHT:ORB1',
    qty: 2,
  };

  it('round-trips signed lines', () => {
    const value = encodeDemoCart([line], SECRET);
    expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decodeDemoCart(value, SECRET)).toEqual([line]);
  });

  it('reads a forged, foreign or malformed cookie as an empty cart', () => {
    const value = encodeDemoCart([line], SECRET);
    const [payload, signature] = value.split('.') as [string, string];
    // The client raises the quantity in the payload and keeps the old signature.
    const raised = Buffer.from(
      Buffer.from(payload, 'base64url')
        .toString()
        .replace(/,2\]\]/, ',200]]'),
    ).toString('base64url');
    expect(raised).not.toBe(payload);
    expect(decodeDemoCart(`${raised}.${signature}`, SECRET)).toEqual([]);
    expect(decodeDemoCart(value, 'another-secret-0123456789abcdefghij')).toEqual([]);
    expect(decodeDemoCart(`${payload}.${signature.slice(1)}x`, SECRET)).toEqual([]);
    expect(decodeDemoCart('', SECRET)).toEqual([]);
    expect(decodeDemoCart('garbage', SECRET)).toEqual([]);
    expect(decodeDemoCart(null, SECRET)).toEqual([]);
    // A validly signed payload of the wrong shape is refused too.
    expect(decodeDemoCart(encodeDemoCart([{ ...line, id: 'x' }], SECRET), SECRET)).toEqual([]);
    expect(decodeDemoCart(encodeDemoCart([{ ...line, qty: 0 }], SECRET), SECRET)).toEqual([]);
    expect(decodeDemoCart(encodeDemoCart([line, line], SECRET), SECRET)).toEqual([]);
  });

  it('refuses more lines than the live cart allows', () => {
    const many = Array.from({ length: MAX_CART_LINES + 1 }, () => ({
      ...line,
      id: newDemoLineId(),
    }));
    expect(() => encodeDemoCart(many, SECRET)).toThrow(RangeError);
  });

  it('is an httpOnly Lax cookie, Secure on https, cleared when empty', () => {
    const http = demoCartSetCookie('v.s', env);
    expect(http).toBe(`${DEMO_CART_COOKIE}=v.s; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
    const https = demoCartSetCookie('v.s', demoEnv({ APP_BASE_URL: 'https://demo.example' }));
    expect(https).toMatch(/; Secure$/);
    expect(demoCartSetCookie(null, env)).toContain('Max-Age=0');
  });
});

describe('DemoCartService', () => {
  it('adds an offer at the fixture price and merges a repeated add', async () => {
    const offer = sellable()[0]!;
    const { jar, box } = memoryJar();
    const cart = service(jar);
    const first = await cart.addItem({ token: null, q: 'oc 90', offerId: offer.id });
    expect(first).toMatchObject({ count: 1, created: true, token: '' });
    expect(first.totalKop).toBe(offer.priceClientKop * Math.max(1, offer.multiplicity));
    expect(box.lines).toEqual([
      {
        id: expect.any(String),
        q: 'OC90',
        offerId: offer.id,
        qty: Math.max(1, offer.multiplicity),
      },
    ]);
    const again = await cart.addItem({ token: null, q: 'OC90', offerId: offer.id });
    expect(again.count).toBe(1);
    expect(box.lines[0]?.qty).toBe(2 * Math.max(1, offer.multiplicity));

    const view = await cart.viewCart(null);
    expect(view?.cartId).toBe('demo');
    expect(view?.lines).toHaveLength(1);
    expect(view?.lines[0]).toMatchObject({
      offerKey: offer.id,
      priceClientKop: offer.priceClientKop,
      status: 'ok',
      stale: false,
    });
    expect(view?.changes).toEqual([]);
  });

  it('updates and removes lines by id', async () => {
    const offer = sellable()[0]!;
    const step = Math.max(1, offer.multiplicity);
    const { jar, box } = memoryJar();
    const cart = service(jar);
    await cart.addItem({ token: null, q: 'OC90', offerId: offer.id });
    const id = box.lines[0]!.id;
    const updated = await cart.updateItem({ token: null, lineId: id, qty: String(step * 2) });
    expect(updated).toEqual({ count: 1, totalKop: offer.priceClientKop * step * 2 });
    await expect(cart.updateItem({ token: null, lineId: id, qty: '0' })).rejects.toMatchObject({
      code: 'qty',
    });
    await expect(
      cart.updateItem({ token: null, lineId: newDemoLineId(), qty: '1' }),
    ).rejects.toMatchObject({ code: 'line_not_found' });
    expect(await cart.removeItem({ token: null, lineId: id })).toEqual({ count: 0, totalKop: 0 });
    expect(box.lines).toEqual([]);
    expect(await cart.viewCart(null)).toBeNull();
  });

  it('validates like the live cart and never trusts a price', async () => {
    const { jar, box } = memoryJar();
    const cart = service(jar);
    await expect(cart.addItem({ token: null, q: 'OC', offerId: 'x' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      cart.addItem({ token: null, q: 'OC90', offerId: 'OC90:NOPE:NOPE' }),
    ).rejects.toMatchObject({ code: 'offer_not_found' });
    const excluded = oc90.find((offer) => offer.excluded);
    if (excluded) {
      await expect(
        cart.addItem({ token: null, q: 'OC90', offerId: excluded.id }),
      ).rejects.toMatchObject({ code: 'excluded' });
    }
    expect(box.writes).toBe(0);
  });

  it('keeps the live limits: lines and total', async () => {
    const offer = sellable()[0]!;
    const full = Array.from({ length: MAX_CART_LINES }, () => ({
      id: newDemoLineId(),
      q: 'OC90',
      offerId: `OC90:OTHER:${newDemoLineId()}`,
      qty: 1,
    }));
    const { jar } = memoryJar(full);
    await expect(
      service(jar).addItem({ token: null, q: 'OC90', offerId: offer.id }),
    ).rejects.toMatchObject({ code: 'cart_full' });

    const step = Math.max(1, offer.multiplicity);
    const huge = Math.min(9999, Math.floor(offer.available / step) * step);
    if (offer.priceClientKop * huge > MAX_ORDER_TOTAL_KOP) {
      const { jar: other } = memoryJar();
      await expect(
        service(other).addItem({ token: null, q: 'OC90', offerId: offer.id, qty: String(huge) }),
      ).rejects.toMatchObject({ code: 'cart_total' });
    }
  });

  it('drops lines whose offer is gone instead of failing the page', async () => {
    const offer = sellable()[0]!;
    const { jar } = memoryJar([
      { id: newDemoLineId(), q: 'OC90', offerId: offer.id, qty: Math.max(1, offer.multiplicity) },
      { id: newDemoLineId(), q: 'OC90', offerId: 'OC90:GONE:ORB9', qty: 1 },
    ]);
    const view = await service(jar).viewCart(null);
    expect(view?.lines.map((line) => line.offerKey)).toEqual([offer.id]);
  });
});

describe('/api/cart/** in DEMO_MODE', () => {
  function deps(): DemoCartRequestDeps {
    return { env, service: (jar) => service(jar) };
  }

  function form(path: string, body: Record<string, string>, cookie?: string): Request {
    return new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(body).toString(),
    });
  }

  function demoCookie(response: Response): string | null {
    const header = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${DEMO_CART_COOKIE}=`));
    return header ? (header.split(';')[0] ?? null) : null;
  }

  it('adds through the live handler and sets only demo_cart', async () => {
    const offer = sellable()[0]!;
    const request = form('/api/cart/items', { q: 'OC90', offerId: offer.id });
    const response = await handleDemoCartRequest(request, deps(), (handlerDeps) =>
      handleAddItem(request, handlerDeps),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/cart?added=1');
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith('cart='))).toBe(false);
    const cookie = demoCookie(response);
    expect(cookie).toBeTruthy();
    const lines = decodeDemoCart(cookie!.slice(DEMO_CART_COOKIE.length + 1), SECRET);
    expect(lines).toHaveLength(1);

    // Removing the line through the line handler clears the cookie.
    const remove = form(`/api/cart/items/${lines[0]!.id}`, { _method: 'delete' }, cookie!);
    const removed = await handleDemoCartRequest(remove, deps(), (handlerDeps) =>
      handleLineRequest(remove, lines[0]!.id, handlerDeps),
    );
    expect(removed.status).toBe(303);
    expect(removed.headers.get('location')).toBe('/cart');
    expect(removed.headers.getSetCookie().join('\n')).toContain(
      `${DEMO_CART_COOKIE}=; Path=/; Max-Age=0`,
    );
  });

  it('keeps the origin check and the error redirects of the live handler', async () => {
    const offer = sellable()[0]!;
    const foreign = new Request(`${ORIGIN}/api/cart/items`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'OC90', offerId: offer.id }),
    });
    const refused = await handleDemoCartRequest(foreign, deps(), (handlerDeps) =>
      handleAddItem(foreign, handlerDeps),
    );
    expect(refused.status).toBe(403);
    expect(demoCookie(refused)).toBeNull();

    const missing = form('/api/cart/items', { q: 'OC90', offerId: 'OC90:NOPE:NOPE' });
    const notFound = await handleDemoCartRequest(missing, deps(), (handlerDeps) =>
      handleAddItem(missing, handlerDeps),
    );
    expect(notFound.status).toBe(303);
    expect(notFound.headers.get('location')).toBe('/cart?error=offer_not_found');
    expect(demoCookie(notFound)).toBeNull();
  });

  it('answers JSON with the count and total', async () => {
    const offer = sellable()[0]!;
    const request = new Request(`${ORIGIN}/api/cart/items`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'OC90', offerId: offer.id }),
    });
    const response = await handleDemoCartRequest(request, deps(), (handlerDeps) =>
      handleAddItem(request, handlerDeps),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      count: 1,
      totalKop: offer.priceClientKop * Math.max(1, offer.multiplicity),
    });
    expect(demoCookie(response)).toBeTruthy();
  });
});
