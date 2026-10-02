// Pure parts of the order page and the cancellation: labels, timeline, cart reminder,
// last-4 comparison, client error texts.
import { ORDER_STATUSES, type CartLine } from '@detaly/domain';
import { describe, expect, it } from 'vitest';
import { cancelErrorText } from '@/components/order/CancelOrderForm';
import { clientCancelContext, isOrderToken } from '@/server/orders/access';
import { cancelFailKey, isLast4, last4Matches } from '@/server/orders/cancel';
import { cartReminder } from '@/server/orders/cart-reminder';
import {
  CLOSED_STATUSES,
  ORDER_STATUS_LABELS,
  orderStatusLabel,
  orderStatusTone,
  PICKUP_CODE_STATUSES,
} from '@/server/orders/status-labels';
import { buildTimeline, eventPhrase, formatEventTime } from '@/server/orders/timeline';

describe('order status labels', () => {
  it('has a Russian label and a tone for every one of the 17 statuses', () => {
    expect(ORDER_STATUSES).toHaveLength(17);
    expect(Object.keys(ORDER_STATUS_LABELS).sort()).toEqual([...ORDER_STATUSES].sort());
    for (const status of ORDER_STATUSES) {
      expect(ORDER_STATUS_LABELS[status]).toMatch(/^[А-ЯЁ][а-яё ,]+$/);
      expect(['wait', 'progress', 'success', 'stopped']).toContain(orderStatusTone(status));
    }
  });

  it('names the 1A statuses as decided', () => {
    expect(orderStatusLabel('awaiting_payment')).toBe('Ждёт оплаты');
    expect(orderStatusLabel('awaiting_confirmation')).toBe('Ждёт подтверждения');
    expect(orderStatusLabel('cancelled')).toBe('Отменён');
    expect(orderStatusLabel('something_new')).toBe('something_new');
  });

  it('shows the pickup code only from ready on, never on closed orders', () => {
    expect(PICKUP_CODE_STATUSES).toContain('ready');
    expect(PICKUP_CODE_STATUSES).not.toContain('awaiting_payment');
    expect(PICKUP_CODE_STATUSES).not.toContain('confirmed');
    for (const status of PICKUP_CODE_STATUSES) {
      expect(CLOSED_STATUSES as readonly string[]).not.toContain(status);
    }
  });
});

describe('timeline', () => {
  const at = (iso: string) => new Date(iso);

  it('formats the time in Asia/Yekaterinburg (UTC+5)', () => {
    expect(formatEventTime(at('2026-10-02T09:05:00Z'))).toBe('2 октября, 14:05');
    // after 19:00 UTC it is already the next day in Orenburg
    expect(formatEventTime(at('2026-10-02T19:30:00Z'))).toBe('3 октября, 00:30');
    expect(formatEventTime(at('2026-12-31T04:00:00Z'))).toBe('31 декабря, 09:00');
  });

  it('turns events into phrases', () => {
    expect(eventPhrase({ type: 'checkout', toStatus: 'awaiting_payment' })).toBe(
      'Заказ оформлен, ждём оплату',
    );
    expect(eventPhrase({ type: 'checkout', toStatus: 'awaiting_confirmation' })).toBe(
      'Заказ оформлен, оплата при получении',
    );
    expect(eventPhrase({ type: 'client_cancelled', toStatus: 'cancelled' })).toBe(
      'Вы отменили заказ',
    );
    expect(eventPhrase({ type: 'supplier_order_requested', toStatus: 'ordering' })).toBe(
      'Статус заказа: Заказываем у поставщика',
    );
    expect(eventPhrase({ type: 'staff_note', toStatus: null })).toBeNull();
  });

  it('orders events by time (then id) and skips events without a status', () => {
    const entries = buildTimeline([
      {
        id: '0002',
        type: 'client_cancelled',
        fromStatus: 'awaiting_payment',
        toStatus: 'cancelled',
        createdAt: at('2026-10-02T10:00:00Z'),
      },
      {
        id: '0003',
        type: 'note',
        fromStatus: null,
        toStatus: null,
        createdAt: at('2026-10-02T09:30:00Z'),
      },
      {
        id: '0001',
        type: 'checkout',
        fromStatus: 'draft',
        toStatus: 'awaiting_payment',
        createdAt: at('2026-10-02T09:05:00Z'),
      },
    ]);
    expect(entries).toEqual([
      {
        id: '0001',
        at: '2026-10-02T09:05:00.000Z',
        timeText: '2 октября, 14:05',
        text: 'Заказ оформлен, ждём оплату',
      },
      {
        id: '0002',
        at: '2026-10-02T10:00:00.000Z',
        timeText: '2 октября, 15:00',
        text: 'Вы отменили заказ',
      },
    ]);
  });
});

describe('order token and cancel context', () => {
  it('accepts only 43 base64url characters', () => {
    expect(isOrderToken('a'.repeat(43))).toBe(true);
    expect(isOrderToken('A-_b'.repeat(10) + 'xyz')).toBe(true);
    expect(isOrderToken('a'.repeat(42))).toBe(false);
    expect(isOrderToken('a'.repeat(44))).toBe(false);
    expect(isOrderToken(`${'a'.repeat(42)}=`)).toBe(false);
    expect(isOrderToken(`${'a'.repeat(42)}/`)).toBe(false);
    expect(isOrderToken(undefined)).toBe(false);
  });

  it('builds the client context with the latest payment status and item arrival', () => {
    expect(
      clientCancelContext({
        scheme: 'prepay',
        latestPaymentStatus: null,
        itemStates: ['pending', 'pending'],
      }),
    ).toEqual({
      actor: 'client',
      scheme: 'prepay',
      providerPaymentStatus: null,
      allLiveItemsArrived: false,
    });
    expect(
      clientCancelContext({
        scheme: 'prepay',
        latestPaymentStatus: 'pending',
        itemStates: ['arrived', 'failed'],
      }),
    ).toMatchObject({ allLiveItemsArrived: true });
  });

  it('keys the failure counter by order', () => {
    expect(cancelFailKey('o1')).toBe('rl:cancel-fail:o1');
    expect(cancelFailKey('o1', 'test:x:')).toBe('test:x:rl:cancel-fail:o1');
  });
});

describe('last4Matches', () => {
  it('compares the last four digits of an E.164 phone', () => {
    expect(last4Matches('6789', '+79123456789')).toBe(true);
    expect(last4Matches('6788', '+79123456789')).toBe(false);
    expect(last4Matches('789', '+79123456789')).toBe(false);
    expect(last4Matches('56789', '+79123456789')).toBe(false);
    expect(last4Matches('abcd', '+79123456789')).toBe(false);
  });

  it('never matches an anonymized or missing phone', () => {
    // anon:<uuid> may end in four digits; it must still not match
    expect(last4Matches('1234', 'anon:0192aaaa-bbbb-7ccc-8ddd-000000001234')).toBe(false);
    expect(last4Matches('1234', null)).toBe(false);
    expect(last4Matches('1234', undefined)).toBe(false);
  });

  it('isLast4 requires exactly four ASCII digits', () => {
    expect(isLast4('0000')).toBe(true);
    expect(isLast4('١٢٣٤')).toBe(false);
    expect(isLast4(1234)).toBe(false);
    expect(isLast4(' 1234')).toBe(false);
  });
});

describe('cancelErrorText', () => {
  it('shows attempts left for wrong digits and the server message otherwise', () => {
    expect(cancelErrorText(422, { error: 'wrong_digits', attemptsLeft: 3 })).toBe(
      'Цифры не совпадают с номером телефона из заказа. Осталось попыток: 3',
    );
    expect(cancelErrorText(422, { error: 'wrong_digits', attemptsLeft: 0 })).toMatch(
      /Попытки закончились/,
    );
    expect(cancelErrorText(409, { error: 'not_cancellable', message: 'нельзя' })).toBe('нельзя');
    expect(cancelErrorText(500, null)).toMatch(/Не получилось отменить заказ/);
  });
});

describe('cartReminder', () => {
  const line = (isLocal: boolean): CartLine => ({ isLocal }) as CartLine;

  it('suggests the second order for what is left in the cart', () => {
    expect(cartReminder([])).toBeNull();
    expect(cartReminder([line(false), line(false)])).toEqual({
      text: 'В корзине остались детали под заказ — оформить второй заказ',
      href: '/checkout?part=order',
    });
    expect(cartReminder([line(true)])).toEqual({
      text: 'В корзине остались детали — оформить второй заказ',
      href: '/checkout',
    });
    expect(cartReminder([line(true), line(false)])?.href).toBe('/cart');
  });
});
