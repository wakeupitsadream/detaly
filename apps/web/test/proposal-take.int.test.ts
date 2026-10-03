// /p/<token> and POST /api/proposals/<token>/take (decision С14) against local PG and Redis with
// the Rossko fixtures: a VIN request answered through the vin-core workflow, the page view
// (re-priced from the cache only), «Оформить и оплатить» into the visitor's cart with the
// request id, the same offer taking the proposal's quantity, refusals (foreign Origin 403,
// unknown 404, expired 410), and logs without tokens.
import { createRedis, type Redis } from '@detaly/config';
import { deleteKeysByPrefix, testKeyPrefix, testRedisUrl } from '@detaly/config/testing';
import { cartItems, carts, createDb, eq, type Db } from '@detaly/db';
import { cartLineFromOffer } from '@detaly/domain';
import { createFixtureCaller } from '@detaly/rossko';
import {
  createVinRequest,
  loadProposal,
  previewVinAnswer,
  saveVinPreview,
  sendVinProposal,
} from '@detaly/vin';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { vinSearchOf } from '@/server/admin/vin-actions-handler';
import { newCartToken } from '@/server/cart-store';
import { getCheckoutGate } from '@/server/checkout-gate';
import { uuidV7 } from '@/server/checkout/uuid';
import { createSupplierDeps, type Supplier } from '@/server/supplier';
import { proposalPageView } from '@/server/vin/proposal-page';
import { handleProposalTake, type ProposalTakeDeps } from '@/server/vin/take-handler';
import { intEnv, webDatabaseUrl } from './helpers';

const BASE = 'http://127.0.0.1:3100';
const env = intEnv({ APP_BASE_URL: BASE, RKN_NOTICE_NUMBER: 'TEST-1' });

let db: Db;
let redis: Redis;
let supplier: Supplier;
const prefixes: string[] = [];
let logs: unknown[] = [];

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 4 });
  redis = createRedis(testRedisUrl());
});

beforeEach(() => {
  const prefix = testKeyPrefix();
  prefixes.push(prefix);
  supplier = createSupplierDeps({
    env,
    db,
    redis,
    keyPrefix: prefix,
    caller: createFixtureCaller(),
  });
  logs = [];
});

afterEach(async () => {
  for (const prefix of prefixes.splice(0)) await deleteKeysByPrefix(redis, prefix);
});

afterAll(async () => {
  await redis.quit();
  await db.close();
});

function deps(): ProposalTakeDeps {
  const log = (level: string) => (details: Record<string, unknown>, message: string) => {
    logs.push([level, details, message]);
  };
  return { db, env, logger: { info: log('info'), error: log('error') } };
}

function phone(): string {
  return `+79${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

/** A VIN request answered with `answer` and sent: the proposal token and the request id. */
async function proposal(answer = '> Колодки передние\nMANN W914/2 1\nTRW GDB1330 1') {
  const gate = await getCheckoutGate({ env, db });
  if (!gate.open) throw new Error('gate closed');
  const request = await createVinRequest(db, {
    vin: 'XTA210990Y1234567',
    carText: null,
    needText: 'фильтр и колодки',
    phone: phone(),
    channel: 'sms',
    photoKeys: [],
    consent: {
      documentVersionId: gate.docs.consentPd.id,
      textSha256: gate.docs.consentPd.sha256,
      ip: null,
      userAgent: null,
    },
    requestKey: uuidV7(),
    now: new Date(),
  });
  const settings = await supplier.settings.get();
  const preview = await previewVinAnswer({
    text: answer,
    search: vinSearchOf(supplier.rossko),
    markupRules: settings.markupRules,
    excludedRules: settings.excludedRules,
    eta: settings.eta,
    now: new Date(),
  });
  expect(preview.errorCount).toBe(0);
  await saveVinPreview(db, { id: request.vinRequestId, answerText: answer, preview });
  const sent = await sendVinProposal({ db }, { id: request.vinRequestId, staffId: null });
  if (!sent.ok) throw new Error(`send refused: ${sent.reason}`);
  return { token: sent.proposalToken, vinRequestId: request.vinRequestId, cartId: sent.cartId };
}

function take(token: string, headers: Record<string, string> = {}) {
  return handleProposalTake(
    new Request(`${BASE}/api/proposals/${token}/take`, {
      method: 'POST',
      headers: { origin: BASE, ...headers },
    }),
    token,
    deps(),
  );
}

function cartCookie(response: Response): string | null {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith('cart='));
  return cookie?.split(';')[0]?.slice('cart='.length) ?? null;
}

describe('/p/<token> view', () => {
  it('shows the lines with client prices, dates and the total; no supplier price leaks', async () => {
    const { token } = await proposal();
    const loaded = await loadProposal(db, token, new Date());
    if (!loaded) throw new Error('proposal not found');
    const view = await proposalPageView(
      { comment: loaded.comment, lines: loaded.lines, expiresAt: loaded.expiresAt, expired: false },
      { rossko: supplier.rossko, loadSettings: () => supplier.settings.get() },
    );
    expect(view.comment).toBe('Колодки передние');
    expect(view.lines.map((l) => [l.brand, l.status])).toEqual([
      ['MANN-FILTER', 'ok'],
      ['TRW', 'ok'],
    ]);
    expect(view.totalKop).toBe(loaded.totalKop);
    expect(view.lines.every((l) => l.promiseText?.startsWith('к '))).toBe(true);
    expect(view.expired).toBe(false);
    expect(JSON.stringify(view)).not.toMatch(/priceSupplier|markupBp|offerSnapshot/);
  });
});

describe('POST /api/proposals/<token>/take', () => {
  it('without a cart: a new cart with the lines and the request id, 303 /checkout with the cookie', async () => {
    const { token, vinRequestId } = await proposal();
    const response = await take(token);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/checkout');
    const cartToken = cartCookie(response);
    expect(cartToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [cart] = await db
      .select()
      .from(carts)
      .where(eq(carts.anonToken, cartToken ?? ''));
    expect(cart).toMatchObject({ status: 'active', vinRequestId, proposalToken: null });
    const lines = await db
      .select()
      .from(cartItems)
      .where(eq(cartItems.cartId, cart?.id ?? ''));
    expect(lines.map((l) => l.brand).sort()).toEqual(['MANN-FILTER', 'TRW']);
    // Logs: the request id, never a token.
    const text = JSON.stringify(logs);
    expect(text).toContain(vinRequestId);
    expect(text).not.toContain(token);
    expect(text).not.toContain(cartToken ?? 'missing');
  });

  it('into the visitor cart: the same offer gets the proposal quantity, other lines stay', async () => {
    const { token } = await proposal('MANN W914/2 2');
    const anon = newCartToken();
    const [cart] = await db.insert(carts).values({ anonToken: anon }).returning();
    const settings = await supplier.settings.get();
    const ctx = { ...settings, now: new Date() };
    const mann = (await supplier.rossko.search('W9142')).offers.find(
      (o) => o.brand === 'MANN-FILTER' && !o.isCross,
    );
    const knecht = (await supplier.rossko.search('OC90')).offers.find(
      (o) => o.brand === 'Knecht' && o.stock.stockId === 'ORB1',
    );
    if (!cart || !mann || !knecht) throw new Error('fixtures missing');
    for (const [offer, q] of [
      [mann, 'W9142'],
      [knecht, 'OC90'],
    ] as const) {
      const line = cartLineFromOffer(offer, q, 1, ctx);
      await db.insert(cartItems).values({
        cartId: cart.id,
        offerKey: line.offerKey,
        searchArticleNorm: line.searchArticleNorm,
        brand: offer.brand,
        article: offer.article,
        name: offer.name,
        qty: 1,
        stockId: offer.stock.stockId,
        isLocal: line.isLocal,
        etaDate: line.etaDate,
        priceSupplierKop: line.priceSupplierKop,
        priceClientKop: line.priceClientKop,
        markupBp: line.markupBp,
        offerSnapshot: offer,
        fetchedAt: new Date(),
      });
    }
    const response = await take(token, { cookie: `cart=${anon}` });
    expect(response.status).toBe(303);
    expect(cartCookie(response)).toBe(anon);
    const lines = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
    expect(lines.map((l) => [l.brand, l.qty]).sort()).toEqual([
      ['Knecht', 1],
      ['MANN-FILTER', 2],
    ]);
  });

  it('refusals: foreign Origin 403, unknown token 404, expired 410 — nothing copied', async () => {
    const { token, cartId } = await proposal();
    expect((await take(token, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await take('A'.repeat(32))).status).toBe(404);
    expect((await take('short')).status).toBe(404);

    await db
      .update(carts)
      .set({ proposalExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(carts.id, cartId));
    const anon = newCartToken();
    const expired = await take(token, { cookie: `cart=${anon}` });
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain('Попросите мастера обновить подборку');
    expect(await db.select().from(carts).where(eq(carts.anonToken, anon))).toEqual([]);
  });
});
