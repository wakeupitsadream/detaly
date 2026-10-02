// The client timeline covers every transition of the state machine and every journal event:
// each one has its own phrase or is hidden on purpose (section 14.4).
import {
  JOURNAL_EVENTS,
  ORDER_EVENTS,
  TRANSITIONS,
  type ActorType,
  type OrderStatus,
} from '@detaly/domain';
import { describe, expect, it } from 'vitest';
import { buildTimeline, eventPhrase, HIDDEN_TIMELINE_EVENTS } from '@/server/orders/timeline';

function fromStatuses(from: OrderStatus | readonly OrderStatus[]): readonly OrderStatus[] {
  return Array.isArray(from) ? from : [from as OrderStatus];
}

describe('client timeline phrases', () => {
  it('every rule of TRANSITIONS has a phrase of its own or its event is hidden', () => {
    const missing: string[] = [];
    for (const rule of TRANSITIONS) {
      if (HIDDEN_TIMELINE_EVENTS.has(rule.event)) continue;
      for (const from of fromStatuses(rule.from)) {
        for (const actor of rule.actors as readonly ActorType[]) {
          const phrase = eventPhrase({
            type: rule.event,
            fromStatus: from,
            toStatus: rule.to,
            actorType: actor,
            payload: {},
          });
          if (phrase === null || phrase.startsWith('Статус заказа:')) {
            missing.push(`${rule.event} ${from}->${rule.to} (${actor})`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every journal event is either shown or hidden on purpose', () => {
    const shown = JOURNAL_EVENTS.filter((type) => !HIDDEN_TIMELINE_EVENTS.has(type));
    expect([...shown].sort()).toEqual(['orphan_payment', 'receipt_succeeded']);
    expect(
      eventPhrase({ type: 'receipt_succeeded', toStatus: null, payload: { kind: 'offset' } }),
    ).toBe('Чек о получении заказа отправлен');
    expect(
      eventPhrase({ type: 'receipt_succeeded', toStatus: null, payload: { kind: 'prepayment' } }),
    ).toBe('Чек об оплате отправлен');
    expect(
      eventPhrase({ type: 'receipt_succeeded', toStatus: null, payload: { kind: 'refund_full' } }),
    ).toBe('Чек возврата отправлен');
    expect(
      eventPhrase({ type: 'orphan_payment', toStatus: null, payload: { refundId: 'r' } }),
    ).toBe('Получена повторная оплата — возвращаем её');
    expect(
      eventPhrase({ type: 'orphan_payment', toStatus: null, payload: { status: 'succeeded' } }),
    ).toBe('Повторная оплата возвращена');
    expect(
      eventPhrase({ type: 'orphan_payment', toStatus: null, payload: { status: 'failed' } }),
    ).toBeNull();
  });

  it('hidden events are service records of the state machine and the journal', () => {
    const known = new Set<string>([...ORDER_EVENTS, ...JOURNAL_EVENTS]);
    for (const type of HIDDEN_TIMELINE_EVENTS) expect(known.has(type)).toBe(true);
    for (const type of ['reminder', 'webhook_stale', 'recheck_requested', 'recheck_result']) {
      expect(eventPhrase({ type, fromStatus: 'confirmed', toStatus: 'confirmed' })).toBeNull();
    }
    // Seller-only steps.
    expect(
      eventPhrase({ type: 'client_arrived', fromStatus: 'ready', toStatus: 'ready' }),
    ).toBeNull();
    expect(
      eventPhrase({
        type: 'supplier_invoice_paid',
        fromStatus: 'awaiting_supplier_invoice',
        toStatus: 'ordered_at_supplier',
      }),
    ).toBeNull();
  });

  it('wording follows the actor, the target status and the item (brand and article only)', () => {
    const items = new Map([['i1', { brand: 'BOSCH', article: '0 451 103 079' }]]);
    expect(
      eventPhrase(
        {
          type: 'item_cancelled',
          fromStatus: 'ordered_at_supplier',
          toStatus: 'ordered_at_supplier',
          actorType: 'client',
          payload: { itemId: 'i1' },
        },
        items,
      ),
    ).toBe('Вы отменили позицию: BOSCH 0 451 103 079');
    expect(
      eventPhrase(
        {
          type: 'item_cancelled',
          fromStatus: 'needs_attention',
          toStatus: 'ordered_at_supplier',
          actorType: 'staff',
          payload: { itemId: 'gone' },
        },
        items,
      ),
    ).toBe('Позиция отменена');
    expect(
      eventPhrase({ type: 'item_arrived', fromStatus: 'ordered_at_supplier', toStatus: 'ready' }),
    ).toBe('Заказ приехал и готов к выдаче');
    expect(
      eventPhrase({
        type: 'client_refused',
        fromStatus: 'confirmed',
        toStatus: 'cancelled',
        actorType: 'staff',
      }),
    ).toBe('Заказ отменён');
    expect(
      eventPhrase({
        type: 'payment_succeeded',
        fromStatus: 'cancelled',
        toStatus: 'refund_pending',
      }),
    ).toBe('Оплата пришла после отмены заказа — возвращаем деньги');
  });

  it('never shows payloads: an amount or an id in the payload does not reach the text', () => {
    const entries = buildTimeline([
      {
        id: 'e1',
        type: 'refund_succeeded',
        fromStatus: 'refund_pending',
        toStatus: 'refunded',
        createdAt: new Date('2026-10-02T09:05:00Z'),
        actorType: 'webhook',
        payload: { refundId: 'secret-refund', amountKop: 123_456 },
      },
    ]);
    expect(entries.map((e) => e.text)).toEqual(['Деньги отправлены']);
    expect(JSON.stringify(entries)).not.toContain('secret-refund');
  });
});
