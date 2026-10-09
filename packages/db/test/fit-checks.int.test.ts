// Step 4 (docs/fit-check.md): fit_checks, the order_items columns checkout copies and the `fit`
// seller cards (migration 0007).
import { randomBytes, randomUUID } from 'node:crypto';
import { testDatabaseUrl } from '@detaly/config/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client';
import { cartItems, carts, fitChecks, orderItems, sellerCards } from '../src/schema';
import { expectPgError, insertOrder, randomToken, SAMPLE_OFFER } from './helpers';

const CHECK = '23514';
const UNIQUE = '23505';
/** A synthetic VIN that passes isValidVin (never a real car). */
const VIN = 'XTA21099012345678';
const DAY = 86_400_000;

let db: Db;

beforeAll(() => {
  db = createDb(testDatabaseUrl(), { max: 4 });
});

afterAll(async () => {
  await db?.close();
});

async function cartWithLine() {
  const [cart] = await db.insert(carts).values({ anonToken: randomToken() }).returning();
  if (!cart) throw new Error('cart not inserted');
  const [line] = await db
    .insert(cartItems)
    .values({
      cartId: cart.id,
      offerKey: `W9142:MANN:${randomBytes(4).toString('hex')}`,
      searchArticleNorm: 'W9142',
      brand: 'MANN',
      article: 'W 914/2',
      name: 'Фильтр масляный',
      qty: 1,
      stockId: 'ORB1',
      isLocal: true,
      priceSupplierKop: 100_000,
      priceClientKop: 128_000,
      markupBp: 2800,
      offerSnapshot: SAMPLE_OFFER,
      fetchedAt: new Date(),
    })
    .returning();
  if (!line) throw new Error('line not inserted');
  return { cart, line };
}

type FitInsert = typeof fitChecks.$inferInsert;

function check(cartId: string, cartItemId: string, over: Partial<FitInsert> = {}): FitInsert {
  const now = new Date();
  return {
    cartId,
    cartItemId,
    requestId: randomUUID(),
    vin: VIN,
    comment: 'двигатель 1.6, 2019',
    brand: 'MANN',
    article: 'W 914/2',
    name: 'Фильтр масляный',
    createdAt: now,
    expiresAt: new Date(now.getTime() + DAY),
    ...over,
  };
}

describe('fit_checks', () => {
  it('a pending line by default, with a uuid v7 id', async () => {
    const { cart, line } = await cartWithLine();
    const [row] = await db.insert(fitChecks).values(check(cart.id, line.id)).returning();
    expect(row?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(row).toMatchObject({
      status: 'pending',
      answeredAt: null,
      answeredBy: null,
      analogBrand: null,
      analogKeptAt: null,
    });
  });

  it('answers: fits and analog with its offer; vin and comment may be cleared', async () => {
    const { cart, line } = await cartWithLine();
    const at = new Date();
    await db.insert(fitChecks).values(check(cart.id, line.id, { status: 'fits', answeredAt: at }));
    const [analog] = await db
      .insert(fitChecks)
      .values(
        check(cart.id, line.id, {
          status: 'analog',
          answeredAt: at,
          analogBrand: 'KNECHT',
          analogArticle: 'OC 90',
          analogName: 'Фильтр масляный',
          analogOffer: { ...SAMPLE_OFFER, brand: 'KNECHT', article: 'OC 90', articleNorm: 'OC90' },
          analogKeptAt: at,
        }),
      )
      .returning();
    expect(analog?.analogOffer?.articleNorm).toBe('OC90');
    await db
      .update(fitChecks)
      .set({ vin: null, comment: null })
      .where(eq(fitChecks.id, analog!.id));
  });

  it.each<[string, Partial<FitInsert>, string]>([
    ['an unknown status', { status: 'ok' }, 'fit_checks_status_check'],
    ['a VIN with O', { vin: 'XTA2109901234567O' }, 'fit_checks_vin_check'],
    ['a VIN in lower case', { vin: VIN.toLowerCase() }, 'fit_checks_vin_check'],
    ['a comment over 200', { comment: 'x'.repeat(201) }, 'fit_checks_comment_check'],
    ['an empty comment', { comment: '' }, 'fit_checks_comment_check'],
    ['an empty article', { article: ' ' }, 'fit_checks_part_check'],
    ['an answer without its time', { status: 'fits' }, 'fit_checks_answer_check'],
    ['a pending line with an answer time', { answeredAt: new Date() }, 'fit_checks_answer_check'],
    [
      'an analog without its part',
      { status: 'analog', answeredAt: new Date() },
      'fit_checks_analog_check',
    ],
    [
      'analog columns on another answer',
      { status: 'fits', answeredAt: new Date(), analogBrand: 'KNECHT' },
      'fit_checks_analog_check',
    ],
    [
      '«Оставить как есть» on a line without an analog',
      { status: 'fits', answeredAt: new Date(), analogKeptAt: new Date() },
      'fit_checks_analog_kept_check',
    ],
    [
      'an expiry before the request',
      { expiresAt: new Date(Date.now() - DAY) },
      'fit_checks_expires_at_check',
    ],
  ])('refuses %s (23514)', async (_name, over, constraint) => {
    const { cart, line } = await cartWithLine();
    await expectPgError(
      db.insert(fitChecks).values(check(cart.id, line.id, over)),
      CHECK,
      constraint,
    );
  });

  it('a line once per request', async () => {
    const { cart, line } = await cartWithLine();
    const requestId = randomUUID();
    await db.insert(fitChecks).values(check(cart.id, line.id, { requestId }));
    await expectPgError(
      db.insert(fitChecks).values(check(cart.id, line.id, { requestId })),
      UNIQUE,
      'fit_checks_request_id_cart_item_id_unique',
    );
  });

  it('a removed line keeps its check (cart_item_id null); the cart takes its checks along', async () => {
    const { cart, line } = await cartWithLine();
    const [row] = await db.insert(fitChecks).values(check(cart.id, line.id)).returning();
    await db.delete(cartItems).where(eq(cartItems.id, line.id));
    const [kept] = await db.select().from(fitChecks).where(eq(fitChecks.id, row!.id));
    expect(kept?.cartItemId).toBeNull();
    expect(kept?.brand).toBe('MANN');
    await db.delete(carts).where(eq(carts.id, cart.id));
    expect(await db.select().from(fitChecks).where(eq(fitChecks.id, row!.id))).toEqual([]);
  });
});

describe('order_items: the copy of a fit check', () => {
  it('no guarantee by default; a guarantee needs the check time; the check may go', async () => {
    const order = await insertOrder(db);
    const { cart, line } = await cartWithLine();
    const at = new Date();
    const [fit] = await db
      .insert(fitChecks)
      .values(check(cart.id, line.id, { status: 'fits', answeredAt: at }))
      .returning();
    const item = (over: Partial<typeof orderItems.$inferInsert> = {}) => ({
      orderId: order.id,
      offerKey: 'W9142:MANN:ORB1',
      searchArticleNorm: 'W9142',
      brand: 'MANN',
      article: 'W 914/2',
      name: 'Фильтр масляный',
      qty: 1,
      stockId: 'ORB1',
      isLocal: true,
      priceSupplierAtOrderKop: 100_000,
      priceClientKop: 128_000,
      markupBp: 2800,
      offerSnapshot: SAMPLE_OFFER,
      ...over,
    });
    const [plain] = await db.insert(orderItems).values(item()).returning();
    expect(plain).toMatchObject({ fitCheckId: null, fitCheckedAt: null, fitGuarantee: false });
    await expectPgError(
      db.insert(orderItems).values(item({ fitGuarantee: true })),
      CHECK,
      'order_items_fit_guarantee_check',
    );
    const [checked] = await db
      .insert(orderItems)
      .values(item({ fitCheckId: fit!.id, fitCheckedAt: at, fitGuarantee: true }))
      .returning();
    expect(checked?.fitGuarantee).toBe(true);
    // The cart (and its checks) gone: the item keeps the time and the guarantee.
    await db.delete(carts).where(eq(carts.id, cart.id));
    const [after] = await db.select().from(orderItems).where(eq(orderItems.id, checked!.id));
    expect(after).toMatchObject({ fitCheckId: null, fitGuarantee: true });
    expect(after?.fitCheckedAt).toBeInstanceOf(Date);
  });
});

describe('seller_cards of fit checks', () => {
  it('a fit card belongs to a request and to nothing else (23514)', async () => {
    const order = await insertOrder(db);
    const card = (extra: Partial<typeof sellerCards.$inferInsert>) => ({
      chatId: '-100123',
      nonce: randomBytes(6).toString('base64url'),
      kind: 'fit',
      ...extra,
    });
    const requestId = randomUUID();
    const [fit] = await db
      .insert(sellerCards)
      .values(card({ fitRequestId: requestId }))
      .returning();
    expect(fit).toMatchObject({ kind: 'fit', fitRequestId: requestId, orderId: null });
    await expectPgError(
      db.insert(sellerCards).values(card({ fitRequestId: requestId, orderId: order.id })),
      CHECK,
      'seller_cards_owner_check',
    );
    await expectPgError(
      db.insert(sellerCards).values(card({ orderId: order.id })),
      CHECK,
      'seller_cards_fit_owner_check',
    );
    await expectPgError(
      db.insert(sellerCards).values(card({ fitRequestId: requestId, kind: 'order' })),
      CHECK,
      'seller_cards_fit_owner_check',
    );
  });
});
