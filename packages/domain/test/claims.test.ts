import { describe, expect, it } from 'vitest';
import {
  CLAIM_ANSWER_DAYS,
  CLAIM_DECISION_LABELS,
  CLAIM_DECISIONS,
  CLAIM_KIND_HINTS,
  CLAIM_KIND_LABELS,
  CLAIM_KINDS,
  claimDeadline,
  claimKindsAvailable,
  claimRefundReason,
  ORDER_STATUSES,
  REFUND_REASONS,
  REFUSABLE_STATUSES,
  refusalLastDay,
  type ClaimKindsInput,
} from '../src';

/** Local Orenburg wall time (UTC+5). */
const at = (date: string, time: string) => new Date(`${date}T${time}:00+05:00`);

const handed = (extra: Partial<ClaimKindsInput> = {}): ClaimKindsInput => ({
  status: 'handed',
  scheme: 'prepay',
  moneyHeld: true,
  // Handed on Thursday 1 October at 18:00 local, promised for the same day.
  handedAt: at('2026-10-01', '18:00'),
  promisedDate: '2026-10-01',
  now: at('2026-10-02', '10:00'),
  ...extra,
});

describe('claimDeadline', () => {
  it('is exactly 10 days (240 hours) after the claim', () => {
    const opened = new Date('2026-10-02T17:31:12.345Z');
    expect(claimDeadline(opened).toISOString()).toBe('2026-10-12T17:31:12.345Z');
    expect(claimDeadline(opened).getTime() - opened.getTime()).toBe(
      CLAIM_ANSWER_DAYS * 24 * 3600 * 1000,
    );
  });

  it('rejects an invalid date', () => {
    expect(() => claimDeadline(new Date('nope'))).toThrow(RangeError);
  });
});

describe('claimKindsAvailable', () => {
  it('after the handover: refusal, not_fit and defect; no delay when handed on time', () => {
    expect(claimKindsAvailable(handed())).toEqual(['refusal', 'not_fit', 'defect']);
    expect(claimKindsAvailable(handed({ status: 'completed' }))).toEqual([
      'refusal',
      'not_fit',
      'defect',
    ]);
  });

  it('refusal and not_fit end with the 7th day after the handover, in the client zone', () => {
    // Handed 1 October: the period runs 2..8 October inclusive.
    expect(refusalLastDay(at('2026-10-01', '18:00'))).toBe('2026-10-08');
    expect(claimKindsAvailable(handed({ now: at('2026-10-08', '23:59') }))).toContain('refusal');
    expect(claimKindsAvailable(handed({ now: at('2026-10-09', '00:00') }))).toEqual(['defect']);
    // 8 October 20:00 UTC is already 9 October 01:00 in Orenburg: too late.
    expect(claimKindsAvailable(handed({ now: new Date('2026-10-08T20:00:00Z') }))).toEqual([
      'defect',
    ]);
    // A handover at 23:30 local is 18:30 UTC of the same day: still day 0 = 1 October.
    expect(
      claimKindsAvailable(
        handed({ handedAt: at('2026-10-01', '23:30'), now: at('2026-10-08', '12:00') }),
      ),
    ).toContain('not_fit');
  });

  it('a delay after the handover: handed later than promised', () => {
    expect(claimKindsAvailable(handed({ promisedDate: '2026-09-30' }))).toEqual([
      'refusal',
      'not_fit',
      'defect',
      'delay',
    ]);
    // a defect and a late handover stay claimable after the refusal period
    expect(
      claimKindsAvailable(handed({ promisedDate: '2026-09-30', now: at('2026-11-20', '12:00') })),
    ).toEqual(['defect', 'delay']);
  });

  it('before the handover: only delay, only with money held and a past promised date', () => {
    const before = (extra: Partial<ClaimKindsInput> = {}) =>
      claimKindsAvailable(
        handed({
          status: 'ordered_at_supplier',
          handedAt: null,
          promisedDate: '2026-10-05',
          now: at('2026-10-06', '09:00'),
          ...extra,
        }),
      );
    expect(before()).toEqual(['delay']);
    // the promised day itself is not late yet
    expect(before({ now: at('2026-10-05', '20:00') })).toEqual([]);
    // pay on handover without a payment: no money to return, no delay claim
    expect(before({ scheme: 'pay_on_handover', moneyHeld: false })).toEqual([]);
    // pay on handover with a held handover payment
    expect(before({ status: 'awaiting_handover_payment', moneyHeld: true })).toEqual(['delay']);
    expect(before({ promisedDate: null })).toEqual([]);
    for (const status of REFUSABLE_STATUSES) expect(before({ status })).toEqual(['delay']);
  });

  it('a ready order is late only when it arrived after the promised date', () => {
    const ready = (extra: Partial<ClaimKindsInput> = {}) =>
      claimKindsAvailable(
        handed({
          status: 'ready',
          handedAt: null,
          // promised Wednesday, arrived Tuesday, the client comes on Thursday
          promisedDate: '2026-10-07',
          receivedAt: at('2026-10-06', '15:00'),
          now: at('2026-10-08', '12:00'),
          ...extra,
        }),
      );
    expect(ready()).toEqual([]);
    expect(ready({ status: 'awaiting_handover_payment' })).toEqual([]);
    // arrived on the promised day itself: on time
    expect(ready({ receivedAt: at('2026-10-07', '18:30') })).toEqual([]);
    // arrived a day late
    expect(ready({ receivedAt: at('2026-10-08', '09:00') })).toEqual(['delay']);
    // the arrival day is taken in the client zone (2026-10-07T20:00Z is 8 Oct in Orenburg)
    expect(ready({ receivedAt: new Date('2026-10-07T20:00:00Z') })).toEqual(['delay']);
    // not arrived yet (no received_at): judged by today, as before
    expect(ready({ status: 'ordered_at_supplier', receivedAt: null })).toEqual(['delay']);
  });

  it('nothing in the other statuses', () => {
    const open = new Set<string>([...REFUSABLE_STATUSES, 'handed', 'completed']);
    for (const status of ORDER_STATUSES.filter((s) => !open.has(s))) {
      expect(claimKindsAvailable(handed({ status, promisedDate: '2026-09-01' })), status).toEqual(
        [],
      );
    }
    // handed without handed_at (should not happen): nothing rather than a wrong period
    expect(claimKindsAvailable(handed({ handedAt: null }))).toEqual([]);
  });
});

describe('claim labels and refund reasons', () => {
  it('every kind refunds with a reason of the same name', () => {
    for (const kind of CLAIM_KINDS) {
      expect(REFUND_REASONS).toContain(claimRefundReason(kind));
      expect(claimRefundReason(kind)).toBe(kind);
    }
  });

  it('every kind and decision has a Russian label', () => {
    for (const kind of CLAIM_KINDS) {
      expect(CLAIM_KIND_LABELS[kind]).toMatch(/[а-я]/i);
      expect(CLAIM_KIND_HINTS[kind]).toMatch(/[а-я]/i);
    }
    for (const decision of CLAIM_DECISIONS) expect(CLAIM_DECISION_LABELS[decision]).toBeTruthy();
  });
});
