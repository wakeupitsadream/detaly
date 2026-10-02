import { ORDER_EVENTS } from '@detaly/domain';
import { describe, expect, it } from 'vitest';
import {
  actionTarget,
  buildCallbackData,
  CALLBACK_ACTIONS,
  CALLBACK_DATA_MAX_BYTES,
  CLIENT_ACTIONS,
  EVENT_ACTIONS,
  eventForAction,
  isCallbackAction,
  isEventAction,
  isMenuAction,
  isOwnerOnlyAction,
  MENU_ACTIONS,
  menuAction,
  newNonce,
  parseCallbackData,
} from '../src';

const UUID = '0192f0c4-7b1a-7cde-8f00-0123456789ab';

/** Table 13.2 of docs/phase-1b-implementation.md: code -> event (null: menu or non-event). */
const TABLE_13_2: Record<string, string | null> = {
  recheck: 'supplier_order_requested',
  refused: 'client_refused',
  cancel: 'order_cancelled',
  anyway: 'order_anyway',
  ialt: null,
  alt1: 'alternative_proposed',
  alt2: 'alternative_proposed',
  alt3: 'alternative_proposed',
  ieta: null,
  eta2: 'new_eta_proposed',
  eta5: 'new_eta_proposed',
  eta7: 'new_eta_proposed',
  eta14: 'new_eta_proposed',
  icancel: 'item_cancelled',
  iprob: null,
  pdecl: 'item_problem',
  pwrong: 'item_problem',
  pdmg: 'item_damaged_on_receipt',
  pdelay: 'item_problem',
  iarr: 'item_arrived',
  invpaid: 'supplier_invoice_paid',
  came: 'client_arrived',
  rcpt: 'offset_receipt_requested',
  qr: 'handover_payment_requested',
  handed: 'handed_over',
  noshow: 'storage_expired',
  back: null,
  dlq: null,
};

/** Phase 0 CALLBACK_ACTIONS: eventForAction keeps returning the same events. */
const PHASE_0: Record<string, string> = {
  confirm: 'client_confirmed',
  approve: 'client_approved',
  refund: 'client_refund_requested',
  recheck: 'supplier_order_requested',
  cancel: 'order_cancelled',
  refused: 'client_refused',
  alt: 'alternative_proposed',
  neweta: 'new_eta_proposed',
  anyway: 'order_anyway',
  invpaid: 'supplier_invoice_paid',
  came: 'client_arrived',
  qr: 'handover_payment_requested',
  handed: 'handed_over',
};

describe('callback actions', () => {
  it('cover table 13.2 with the documented events', () => {
    for (const [code, event] of Object.entries(TABLE_13_2)) {
      expect(isCallbackAction(code), code).toBe(true);
      expect(eventForAction(code), code).toBe(event);
    }
  });

  it('eventForAction keeps the phase 0 behaviour', () => {
    for (const [code, event] of Object.entries(PHASE_0)) expect(eventForAction(code)).toBe(event);
    expect(eventForAction('toString')).toBeNull();
    expect(eventForAction('unknown')).toBeNull();
    expect(eventForAction('')).toBeNull();
  });

  it('splits into event and menu codes without overlap', () => {
    expect(Object.keys(MENU_ACTIONS).sort()).toEqual(
      [
        'ialt',
        'ieta',
        'iprob',
        'back',
        'alt1',
        'alt2',
        'alt3',
        'eta2',
        'eta5',
        'eta7',
        'eta14',
        'pdecl',
        'pwrong',
        'pdmg',
        'pdelay',
        'dlq',
      ].sort(),
    );
    for (const code of Object.keys(EVENT_ACTIONS)) {
      expect(isMenuAction(code), code).toBe(false);
      expect(CALLBACK_ACTIONS[code as keyof typeof CALLBACK_ACTIONS]).toBe('event');
    }
    for (const code of Object.keys(MENU_ACTIONS)) {
      expect(isEventAction(code), code).toBe(false);
      expect(CALLBACK_ACTIONS[code as keyof typeof CALLBACK_ACTIONS]).toBe('menu');
    }
    expect(Object.keys(CALLBACK_ACTIONS)).toHaveLength(
      Object.keys(EVENT_ACTIONS).length + Object.keys(MENU_ACTIONS).length,
    );
    expect(Object.isFrozen(CALLBACK_ACTIONS)).toBe(true);
  });

  it('every event is an order event', () => {
    for (const code of Object.keys(CALLBACK_ACTIONS)) {
      const event = eventForAction(code);
      if (event !== null) expect(ORDER_EVENTS, code).toContain(event);
    }
  });

  it('menu options carry their parameter', () => {
    expect(menuAction('eta14')).toMatchObject({ kind: 'eta', days: 14 });
    expect(menuAction('alt3')).toMatchObject({ kind: 'alternative', index: 2 });
    expect(menuAction('pdmg')).toMatchObject({ kind: 'problem', problem: 'damaged' });
    expect(menuAction('pdecl')).toMatchObject({ problem: 'declined' });
    expect(menuAction('pwrong')).toMatchObject({ problem: 'wrong' });
    expect(menuAction('pdelay')).toMatchObject({ problem: 'delay' });
    expect(menuAction('ialt')).toMatchObject({ kind: 'open', menu: 'alternative' });
    expect(menuAction('ieta')).toMatchObject({ kind: 'open', menu: 'eta' });
    expect(menuAction('iprob')).toMatchObject({ kind: 'open', menu: 'problem' });
    expect(menuAction('back')).toMatchObject({ kind: 'back' });
    expect(menuAction('dlq')).toMatchObject({ kind: 'dead_letter' });
    expect(menuAction('recheck')).toBeNull();
    for (const spec of Object.values(MENU_ACTIONS)) expect(spec.label.length).toBeGreaterThan(0);
  });

  it('targets: order, item, either for back, dead-letter id for dlq', () => {
    for (const code of ['recheck', 'refused', 'cancel', 'anyway', 'invpaid', 'came', 'rcpt']) {
      expect(actionTarget(code), code).toBe('order');
    }
    for (const code of ['qr', 'handed', 'noshow', 'confirm', 'approve', 'refund']) {
      expect(actionTarget(code), code).toBe('order');
    }
    for (const code of ['ialt', 'ieta', 'icancel', 'iprob', 'iarr', 'alt2', 'eta7', 'pdmg']) {
      expect(actionTarget(code), code).toBe('item');
    }
    expect(actionTarget('back')).toBe('order_or_item');
    expect(actionTarget('dlq')).toBe('dead_letter');
    expect(actionTarget('nope')).toBeNull();
  });

  it('owner-only and client codes', () => {
    expect(isOwnerOnlyAction('invpaid')).toBe(true);
    expect(isOwnerOnlyAction('dlq')).toBe(true);
    expect(isOwnerOnlyAction('handed')).toBe(false);
    expect([...CLIENT_ACTIONS]).toEqual(['confirm', 'approve', 'refund']);
  });

  it('a:<code>:<uuid>:<nonce8> fits 64 bytes for every code (dlq: 36-char job id)', () => {
    let longest = 0;
    for (const code of Object.keys(CALLBACK_ACTIONS)) {
      // Codes stay short: 7 characters at most (recheck, icancel, invpaid from table 13.2).
      expect(code.length, code).toBeLessThanOrEqual(7);
      const nonce = newNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{8}$/);
      const data = buildCallbackData(code, UUID, nonce);
      longest = Math.max(longest, Buffer.byteLength(data));
      expect(Buffer.byteLength(data), code).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
      expect(parseCallbackData(data)).toEqual({ action: code, orderId: UUID, nonce });
    }
    expect(longest).toBe(55);
    const dlq = buildCallbackData('dlq', 'a'.repeat(36), newNonce());
    expect(Buffer.byteLength(dlq)).toBeLessThanOrEqual(64);
  });
});
