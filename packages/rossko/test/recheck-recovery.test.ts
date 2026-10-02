/**
 * Phase 1B section 8 end to end inside the package (no Redis, no DB): fixture caller variants ->
 * client -> recheckOrder / matchCheckoutResult / recovery by comment. Verification 1B steps 5
 * and 6 on the package level; the worker tests repeat them with the database.
 */
import {
  DEFAULT_EXCLUDED_RULES,
  offerViewId,
  price,
  recheckOrder,
  type MarkupRule,
  type Offer,
  type RecheckItemInput,
} from '@detaly/domain';
import { describe, expect, it } from 'vitest';
import {
  checkoutComment,
  checkoutMayHaveExecuted,
  checkoutResultFromOrders,
  createFixtureCaller,
  createRosskoClient,
  createUnlimitedLimiter,
  findOrdersByComment,
  matchCheckoutResult,
  RosskoCallError,
  UNSUPPORTED_CODE,
  type CheckoutMatchRequest,
  type FixtureCallerOptions,
} from '../src';

const RULES: MarkupRule[] = [{ fromKop: 0, toKop: null, localBp: 2800, orderBp: 2800 }];
const NOW = new Date('2026-10-02T12:00:00Z');

function rossko(options: FixtureCallerOptions = {}) {
  return createRosskoClient({
    caller: createFixtureCaller(options),
    key1: 'k1',
    key2: 'k2',
    deliveryId: '000000001',
    paymentId: '1',
    localStockIds: ['ORB1'],
    limiter: createUnlimitedLimiter(),
    allowCheckout: true,
  });
}

/** The order item as checkout stored it: Knecht OC 90 from MSK7 at the recorded price. */
async function orderedItem(qty: number): Promise<RecheckItemInput> {
  const { offers } = await rossko().search('OC90');
  const offer = offers.find((o) => offerViewId(o) === 'OC90:Knecht:MSK7') as Offer;
  return {
    orderItemId: 'item-oc90',
    offerKey: offerViewId(offer),
    searchArticleNorm: 'OC90',
    qty,
    priceSupplierKop: offer.priceSupplierKop,
    priceClientKop: price(RULES, offer.priceSupplierKop, offer.stock.isLocal).priceClientKop,
    offer,
  };
}

async function recheckWithFactor(priceFactorBp: number) {
  const item = await orderedItem(2);
  const fresh = await rossko({ priceFactorBp }).search('OC90', {
    priority: 'critical',
    bypassCache: true,
  });
  return recheckOrder({
    items: [item],
    freshBySearch: new Map([['OC90', fresh.offers]]),
    markupRules: RULES,
    excludedRules: DEFAULT_EXCLUDED_RULES,
    eta: { bufferDays: 1, invoiceLagDays: 1, prepayInvoice: false },
    now: NOW,
    marginFloorBp: 1_000,
    driftToleranceBp: 300,
  });
}

describe('recheck on the fixture caller (Verification 1B step 5)', () => {
  it('+1% passes a 3% tolerance', async () => {
    const result = await recheckWithFactor(10_100);
    expect(result).toMatchObject({ priceDriftBp: 100, allAvailable: true, reason: null });
    expect(result.items[0]?.alternatives).toEqual([]);
  });

  it('+10% fails and proposes crosses of OC90 at the client price', async () => {
    const result = await recheckWithFactor(11_000);
    expect(result).toMatchObject({
      priceDriftBp: 1_000,
      allAvailable: true,
      reason: 'price_drift',
    });
    const alternatives = result.items[0]?.alternatives ?? [];
    expect(alternatives.map((a) => [a.offerKey, a.offer.isCross, a.priceSupplierKop])).toEqual([
      ['OC90:MAHLE:EKB2', true, 43_791],
    ]);
    expect(alternatives[0]).toMatchObject({ priceClientKop: 49_800, marginBp: 1_206 });
    expect(alternatives[0]?.marginBp).toBeGreaterThanOrEqual(1_000);
  });
});

describe('GetCheckout itemErrors (Verification 1B step 6)', () => {
  it('OC 90 is covered, W 914/2 is in ItemsErrorList', async () => {
    const requested: CheckoutMatchRequest[] = [
      { id: 'oc', brand: 'Knecht', article: 'OC 90', stockId: 'MSK7', count: 1 },
      { id: 'w', brand: 'MANN-FILTER', article: 'W 914/2', stockId: 'MSK7', count: 1 },
    ];
    const result = await rossko({ checkoutVariant: 'itemErrors' }).checkout({
      items: requested,
      comment: checkoutComment('DT-000123', 1),
    });
    const match = matchCheckoutResult(requested, result);
    expect(match.covered.map((c) => c.id)).toEqual(['oc']);
    expect(match.failed.map((f) => [f.id, f.error.message])).toEqual([
      ['w', 'Недостаточно товара на складе'],
    ]);
    expect(result.orderIds).toEqual(['70000002']);
  });
});

describe('recovery after a GetCheckout timeout (decision Б14)', () => {
  const requested: CheckoutMatchRequest[] = [
    { id: 'oc', brand: 'Knecht', article: 'OC 90', stockId: 'MSK7', count: 2 },
    { id: 'w', brand: 'MANN-FILTER', article: 'W 914/2', stockId: 'MSK7', count: 1 },
  ];
  const comment = checkoutComment('DT-000456', 1);
  const calledAt = new Date('2026-10-02T12:30:00Z');

  it('the executed order is found by its comment and covers every line', async () => {
    const client = rossko({ checkoutVariant: 'timeout', now: () => calledAt });
    const error: unknown = await client
      .checkout({ items: requested, comment })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ timeout: true });
    expect(checkoutMayHaveExecuted(error)).toBe(true);

    const { orders } = await client.recentOrders({ since: new Date(calledAt.getTime() - 60_000) });
    const found = findOrdersByComment(orders, comment);
    expect(found.map((o) => o.id)).toEqual(['79000001']);
    const match = matchCheckoutResult(requested, checkoutResultFromOrders(found));
    expect(match.covered.map((c) => c.id)).toEqual(['oc', 'w']);
    expect(match.unmatched).toEqual([]);
  });

  it('a lost request is not found: unknown_after_timeout for the worker', async () => {
    const client = rossko({ checkoutVariant: 'timeoutNotExecuted' });
    await expect(client.checkout({ items: requested, comment })).rejects.toMatchObject({
      timeout: true,
    });
    expect(findOrdersByComment((await client.recentOrders()).orders, comment)).toEqual([]);
  });

  it('a refused list mode is RosskoCallError code unsupported', async () => {
    const client = rossko({ checkoutVariant: 'timeout', ordersList: 'unsupported' });
    await expect(client.checkout({ items: requested, comment })).rejects.toBeInstanceOf(
      RosskoCallError,
    );
    await expect(client.recentOrders()).rejects.toMatchObject({ code: UNSUPPORTED_CODE });
  });
});
