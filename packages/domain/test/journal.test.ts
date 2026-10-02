// Journal events share order_events.type with transition events: the names must never collide,
// or the timeline and the monthly act would read a journal row as a status change.
import { describe, expect, it } from 'vitest';
import { isJournalEvent, JOURNAL_EVENTS, ORDER_EVENTS, TIMERS } from '../src';

describe('JOURNAL_EVENTS', () => {
  it('are unique and disjoint from the state machine events', () => {
    expect(new Set(JOURNAL_EVENTS).size).toBe(JOURNAL_EVENTS.length);
    const transitions: readonly string[] = ORDER_EVENTS;
    expect(JOURNAL_EVENTS.filter((event) => transitions.includes(event))).toEqual([]);
  });

  it('isJournalEvent accepts journal names only', () => {
    expect(isJournalEvent('recheck_requested')).toBe(true);
    expect(isJournalEvent('claim_deferred')).toBe(true);
    expect(isJournalEvent('payment_succeeded')).toBe(false);
    expect(isJournalEvent('')).toBe(false);
    expect(isJournalEvent(null)).toBe(false);
  });
});

describe('TIMERS (PLAN section 1)', () => {
  it('receipt polling: every 2 minutes up to 15 minutes', () => {
    expect(TIMERS.receiptPollEveryMs).toBe(120_000);
    expect(TIMERS.receiptGiveUpMs).toBe(900_000);
    expect(TIMERS.approvalReminderAfterMs).toBe(12 * 3_600_000);
    expect(TIMERS.outboxPollMs).toBe(2_000);
  });
});
