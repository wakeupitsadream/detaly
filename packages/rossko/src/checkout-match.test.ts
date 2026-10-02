import { describe, expect, it } from 'vitest';
import {
  checkoutComment,
  CheckoutMatchError,
  checkoutResultFromOrders,
  findOrderByComment,
  findOrdersByComment,
  matchCheckoutResult,
  type CheckoutMatchRequest,
} from './checkout-match';
import { BUNDLED_FIXTURES, stripMeta } from './fixture-caller';
import { mapCheckoutResult, mapOrdersResult } from './mapper';
import type { CheckoutLine, RosskoOrder } from './types';

const fixture = (name: string): unknown => stripMeta(BUNDLED_FIXTURES[name]);

const OC90_MSK7: CheckoutMatchRequest = {
  id: 'soi-oc90',
  brand: 'Knecht',
  article: 'OC 90',
  stockId: 'MSK7',
  count: 1,
};
const W9142_MSK7: CheckoutMatchRequest = {
  id: 'soi-w9142',
  brand: 'MANN-FILTER',
  article: 'W 914/2',
  stockId: 'MSK7',
  count: 1,
};

function line(over: Partial<CheckoutLine> = {}): CheckoutLine {
  return {
    brand: 'Knecht',
    article: 'OC 90',
    stockId: 'MSK7',
    count: 1,
    priceKop: 38_900,
    ...over,
  };
}

describe('checkoutComment', () => {
  it('is the order number and the attempt', () => {
    expect(checkoutComment('DT-000123', 1)).toBe('DT-000123/1');
    expect(checkoutComment('DT-000123', 12)).toBe('DT-000123/12');
  });

  it.each([
    ['DT-123', 1],
    ['dt-000123', 1],
    ['DT-000123', 0],
    ['DT-000123', 1.5],
  ])('rejects %s / %s', (number, attempt) => {
    expect(() => checkoutComment(number, attempt)).toThrow(RangeError);
  });
});

describe('matchCheckoutResult', () => {
  it('GetCheckout.itemErrors: OC 90 is covered, W 914/2 failed', () => {
    const result = mapCheckoutResult(fixture('GetCheckout.itemErrors'));
    const match = matchCheckoutResult([OC90_MSK7, W9142_MSK7], result);
    expect(match).toEqual({
      covered: [
        {
          id: 'soi-oc90',
          line: { brand: 'Knecht', article: 'OC 90', stockId: 'MSK7', count: 1, priceKop: 38_900 },
        },
      ],
      failed: [
        {
          id: 'soi-w9142',
          error: {
            brand: 'MANN-FILTER',
            article: 'W 914/2',
            stockId: 'MSK7',
            count: 1,
            message: 'Недостаточно товара на складе',
          },
        },
      ],
      unmatched: [],
      unexpectedItems: [],
      unexpectedErrors: [],
    });
  });

  it('GetCheckout.ok: every line covered', () => {
    const result = mapCheckoutResult(fixture('GetCheckout.ok'));
    const match = matchCheckoutResult(
      [
        { id: 'a', brand: 'Knecht', article: 'OC 90', stockId: 'ORB1', count: 2 },
        { id: 'b', brand: 'TRW', article: 'GDB1330', stockId: 'ORB1', count: 1 },
      ],
      result,
    );
    expect(match.covered.map((c) => c.id)).toEqual(['a', 'b']);
    expect(match.failed).toEqual([]);
    expect(match.unmatched).toEqual([]);
  });

  it('compares normalized article and brand, stock case-insensitively', () => {
    const match = matchCheckoutResult([OC90_MSK7], {
      items: [line({ brand: 'KNECHT', article: 'oc-90', stockId: ' msk7 ' })],
      itemErrors: [],
    });
    expect(match.covered.map((c) => c.id)).toEqual(['soi-oc90']);
  });

  it('a different count or stock is not a match: the line stays unmatched', () => {
    const match = matchCheckoutResult([OC90_MSK7, W9142_MSK7], {
      items: [
        line({ count: 2 }),
        line({ article: 'W 914/2', brand: 'MANN-FILTER', stockId: 'EKB2' }),
      ],
      itemErrors: [],
    });
    expect(match.covered).toEqual([]);
    expect(match.unmatched).toEqual(['soi-oc90', 'soi-w9142']);
    expect(match.unexpectedItems).toHaveLength(2);
  });

  it('a result line without a stock matches when the rest is unique', () => {
    const match = matchCheckoutResult([OC90_MSK7], {
      items: [line({ stockId: null })],
      itemErrors: [],
    });
    expect(match.covered.map((c) => c.id)).toEqual(['soi-oc90']);
  });

  it('ambiguity is an error: same line twice in the request', () => {
    expect(() =>
      matchCheckoutResult([OC90_MSK7, { ...OC90_MSK7, id: 'other' }], {
        items: [],
        itemErrors: [],
      }),
    ).toThrow(CheckoutMatchError);
  });

  it('ambiguity is an error: a stockless line fitting two stocks', () => {
    const requested = [OC90_MSK7, { ...OC90_MSK7, id: 'orb', stockId: 'ORB1' }];
    expect(() =>
      matchCheckoutResult(requested, { items: [line({ stockId: null })], itemErrors: [] }),
    ).toThrow(expect.objectContaining({ code: 'ambiguous' }) as Error);
  });

  it('ambiguity is an error: one line both ordered and refused', () => {
    expect(() =>
      matchCheckoutResult([OC90_MSK7], {
        items: [line()],
        itemErrors: [{ ...line(), message: 'Нет' }],
      }),
    ).toThrow(/twice/);
  });

  it('rejects duplicate request ids', () => {
    expect(() =>
      matchCheckoutResult([OC90_MSK7, { ...W9142_MSK7, id: OC90_MSK7.id }], {
        items: [],
        itemErrors: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid' }) as Error);
  });
});

describe('recovery by comment (decision Б14)', () => {
  const orders = mapOrdersResult(fixture('GetOrders.recent')).orders;

  it('finds every order of the attempt, as a whole token', () => {
    expect(findOrdersByComment(orders, 'DT-000123/1').map((o) => o.id)).toEqual([
      '70000011',
      '70000010',
    ]);
    expect(findOrdersByComment(orders, 'dt-000123/12').map((o) => o.id)).toEqual(['70000012']);
    expect(findOrdersByComment(orders, 'DT-000123/2')).toEqual([]);
    expect(findOrdersByComment(orders, ' ')).toEqual([]);
    expect(findOrderByComment(orders, 'DT-000123/1')?.id).toBe('70000011');
    expect(findOrderByComment(orders, 'DT-000999/1')).toBeNull();
  });

  it('found orders read as a successful GetCheckout covering the requested lines', () => {
    const found = findOrdersByComment(orders, checkoutComment('DT-000123', 1));
    const result = checkoutResultFromOrders(found);
    expect(result).toMatchObject({
      success: true,
      orderIds: ['70000011', '70000010'],
      deliveryCostKop: null,
      itemErrors: [],
    });
    const match = matchCheckoutResult(
      [
        { id: 'oc', brand: 'Knecht', article: 'OC 90', stockId: 'ORB1', count: 2 },
        { id: 'w', brand: 'MANN-FILTER', article: 'W 914/2', stockId: 'MSK7', count: 1 },
        { id: 'gdb', brand: 'TRW', article: 'GDB1330', stockId: 'ORB1', count: 1 },
      ],
      result,
    );
    expect(match.covered.map((c) => c.id).sort()).toEqual(['oc', 'w']);
    // Not in the found orders: unknown, never re-ordered automatically.
    expect(match.unmatched).toEqual(['gdb']);
  });

  it('nothing found -> success false and no lines', () => {
    const empty: RosskoOrder[] = [];
    expect(checkoutResultFromOrders(empty)).toEqual({
      success: false,
      message: null,
      orderIds: [],
      deliveryCostKop: null,
      items: [],
      itemErrors: [],
    });
  });
});
