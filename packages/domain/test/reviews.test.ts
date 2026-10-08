// Step 3 (docs/reviews.md): the rating snapshot, the storefront rating line and the conditions of
// the one review reminder, as pure functions.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_MAX_AGE_DAYS,
  DEFAULT_REVIEW_MIN_COUNT,
  DEFAULT_REVIEW_REMINDER_DAYS,
  formatRatingX10,
  isJournalEvent,
  JOURNAL_EVENTS,
  ORDER_EVENTS,
  ORDER_NOTIFY_TEMPLATES,
  parseRatingX10,
  parseReviewCount,
  parseReviewSnapshot,
  ratingBlock,
  REVIEW_BUTTON_TEXTS,
  REVIEW_PLATFORM_LABELS,
  REVIEW_PLATFORM_WHERE,
  REVIEW_PLATFORMS,
  REVIEW_REMINDER_GRACE_DAYS,
  reviewRedirectPath,
  reviewReminderDue,
  reviewReminderVerdict,
  sameReviewSnapshot,
  type ReviewReminderFacts,
  type ReviewSnapshot,
} from '../src';

const YANDEX = 'https://yandex.ru/maps/org/test/1/reviews/';
const TWO_GIS = 'https://2gis.ru/orenburg/firm/1';
const DAY = 86_400_000;

describe('platforms and wording', () => {
  it('two platforms, plain names, no logos', () => {
    expect(REVIEW_PLATFORMS).toEqual(['yandex', '2gis']);
    expect(REVIEW_PLATFORM_LABELS).toEqual({ yandex: 'Яндекс Карты', '2gis': '2ГИС' });
    expect(REVIEW_PLATFORM_WHERE).toEqual({ yandex: 'на Яндекс Картах', '2gis': 'в 2ГИС' });
    expect(REVIEW_BUTTON_TEXTS).toEqual({
      yandex: 'Отзыв в Яндекс Картах',
      '2gis': 'Отзыв в 2ГИС',
    });
  });

  it('the buttons lead to our redirect under the order page, never to the service', () => {
    expect(reviewRedirectPath('/o/abc', 'yandex')).toBe('/o/abc/review/yandex');
    expect(reviewRedirectPath('https://shop.test/o/abc/', '2gis')).toBe(
      'https://shop.test/o/abc/review/2gis',
    );
  });

  it('review_link_opened is a journal event and review_reminder a client template', () => {
    expect(isJournalEvent('review_link_opened')).toBe(true);
    expect((ORDER_EVENTS as readonly string[]).includes('review_link_opened')).toBe(false);
    expect(JOURNAL_EVENTS).toContain('review_link_opened');
    expect(ORDER_NOTIFY_TEMPLATES).toContain('review_reminder');
  });

  it('defaults: reminder after 3 days, from 5 reviews, at most 45 days old', () => {
    expect(DEFAULT_REVIEW_REMINDER_DAYS).toBe(3);
    expect(DEFAULT_REVIEW_MIN_COUNT).toBe(5);
    expect(DEFAULT_REVIEW_MAX_AGE_DAYS).toBe(45);
  });
});

describe('rating and count input', () => {
  it('rating: 1,0–5,0 with one decimal, a comma or a dot', () => {
    expect(parseRatingX10('4,9')).toBe(49);
    expect(parseRatingX10('4.9')).toBe(49);
    expect(parseRatingX10(' 5 ')).toBe(50);
    expect(parseRatingX10('1,0')).toBe(10);
    expect(parseRatingX10('5,0')).toBe(50);
    for (const bad of ['', '0,9', '5,1', '6', '4,95', '4,', ',9', 'четыре', '-4', '4 9', '10']) {
      expect(parseRatingX10(bad), bad).toBeNull();
    }
    expect(formatRatingX10(49)).toBe('4,9');
    expect(formatRatingX10(50)).toBe('5,0');
    expect(formatRatingX10(10)).toBe('1,0');
  });

  it('count: a whole number from 0, spaces allowed', () => {
    expect(parseReviewCount('37')).toBe(37);
    expect(parseReviewCount('0')).toBe(0);
    expect(parseReviewCount('1 200')).toBe(1200);
    expect(parseReviewCount('1 200')).toBe(1200);
    for (const bad of ['', '-1', '3,5', '1e3', 'сорок', '10000000']) {
      expect(parseReviewCount(bad), bad).toBeNull();
    }
  });
});

describe('the stored snapshot', () => {
  const snapshot: ReviewSnapshot = {
    asOf: '2026-10-20',
    ratings: { yandex: { ratingX10: 49, count: 37 }, '2gis': { ratingX10: 48, count: 12 } },
  };

  it('reads a valid value in normal form (platform order, two fields)', () => {
    const parsed = parseReviewSnapshot({
      asOf: '2026-10-20',
      ratings: {
        '2gis': { ratingX10: 48, count: 12, extra: true },
        yandex: { ratingX10: 49, count: 37 },
      },
    });
    expect(parsed).toEqual(snapshot);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(snapshot));
    expect(parseReviewSnapshot({ asOf: '2026-10-20', ratings: {} })).toEqual({
      asOf: '2026-10-20',
      ratings: {},
    });
  });

  it('ignores a malformed value (a hand edit in the database)', () => {
    for (const bad of [
      null,
      'x',
      [],
      { asOf: '2026-13-01', ratings: {} },
      { asOf: '2026-10-20' },
      { asOf: '2026-10-20', ratings: { yandex: { ratingX10: 4.9, count: 37 } } },
      { asOf: '2026-10-20', ratings: { yandex: { ratingX10: 51, count: 37 } } },
      { asOf: '2026-10-20', ratings: { yandex: { ratingX10: 49, count: -1 } } },
      { asOf: '2026-10-20', ratings: { google: { ratingX10: 49, count: 37 } } },
    ]) {
      expect(parseReviewSnapshot(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('equality ignores the key order', () => {
    expect(
      sameReviewSnapshot(snapshot, {
        asOf: '2026-10-20',
        ratings: { '2gis': { ratingX10: 48, count: 12 }, yandex: { ratingX10: 49, count: 37 } },
      }),
    ).toBe(true);
    expect(sameReviewSnapshot(snapshot, { ...snapshot, asOf: '2026-10-21' })).toBe(false);
    expect(sameReviewSnapshot(null, null)).toBe(true);
    expect(sameReviewSnapshot(snapshot, null)).toBe(false);
  });
});

describe('ratingBlock: when the storefront shows the line', () => {
  const snapshot: ReviewSnapshot = {
    asOf: '2026-10-20',
    ratings: { yandex: { ratingX10: 49, count: 37 }, '2gis': { ratingX10: 48, count: 12 } },
  };
  const both = { yandex: YANDEX, '2gis': TWO_GIS };
  const rules = { minCount: 5, maxAgeDays: 45, today: '2026-10-25' };

  it('both platforms with links, enough reviews and a fresh snapshot', () => {
    expect(ratingBlock(snapshot, { ...rules, urls: both })).toEqual({
      asOf: '2026-10-20',
      lines: [
        { platform: 'yandex', ratingX10: 49, count: 37, url: YANDEX },
        { platform: '2gis', ratingX10: 48, count: 12, url: TWO_GIS },
      ],
    });
  });

  it('a platform without its link is never shown; neither link: nothing', () => {
    expect(ratingBlock(snapshot, { ...rules, urls: { yandex: YANDEX } })?.lines).toEqual([
      { platform: 'yandex', ratingX10: 49, count: 37, url: YANDEX },
    ]);
    expect(ratingBlock(snapshot, { ...rules, urls: { '2gis': TWO_GIS } })?.lines).toEqual([
      { platform: '2gis', ratingX10: 48, count: 12, url: TWO_GIS },
    ]);
    expect(ratingBlock(snapshot, { ...rules, urls: {} })).toBeNull();
    expect(ratingBlock(snapshot, { ...rules, urls: { yandex: null, '2gis': undefined } })).toBe(
      null,
    );
  });

  it('min count: a platform below it is left out; at the threshold it is shown', () => {
    expect(
      ratingBlock(snapshot, { ...rules, urls: both, minCount: 13 })?.lines.map((l) => l.platform),
    ).toEqual(['yandex']);
    expect(
      ratingBlock(snapshot, { ...rules, urls: both, minCount: 12 })?.lines.map((l) => l.platform),
    ).toEqual(['yandex', '2gis']);
    expect(ratingBlock(snapshot, { ...rules, urls: both, minCount: 38 })).toBeNull();
    // A rating without a single review is never shown, whatever the threshold.
    expect(
      ratingBlock(
        { asOf: '2026-10-20', ratings: { yandex: { ratingX10: 50, count: 0 } } },
        { ...rules, urls: both, minCount: 0 },
      ),
    ).toBeNull();
  });

  it('max age: shown up to maxAgeDays old, hidden after; a future date is hidden', () => {
    expect(ratingBlock(snapshot, { ...rules, urls: both, today: '2026-12-04' })).not.toBeNull();
    expect(ratingBlock(snapshot, { ...rules, urls: both, today: '2026-12-05' })).toBeNull();
    expect(ratingBlock(snapshot, { ...rules, urls: both, today: '2026-10-20' })).not.toBeNull();
    expect(ratingBlock(snapshot, { ...rules, urls: both, today: '2026-10-19' })).toBeNull();
  });

  it('no snapshot or no numbers: nothing (never a made-up rating)', () => {
    expect(ratingBlock(null, { ...rules, urls: both })).toBeNull();
    expect(ratingBlock({ asOf: '2026-10-20', ratings: {} }, { ...rules, urls: both })).toBeNull();
  });
});

describe('the review reminder', () => {
  const completedAt = new Date('2026-10-10T06:00:00Z');
  const due: ReviewReminderFacts = {
    status: 'completed',
    completedAt,
    now: new Date(completedAt.getTime() + 3 * DAY),
    reminderDays: 3,
    linkOpened: false,
    claimAfterHandover: false,
    linksConfigured: true,
    hasMessenger: true,
  };

  it('due 3 days after completed when nothing happened', () => {
    expect(reviewReminderVerdict(due)).toBe('due');
    expect(reviewReminderDue(due)).toBe(true);
  });

  it('each condition stops it', () => {
    const cases: [Partial<ReviewReminderFacts>, string][] = [
      [{ reminderDays: 0 }, 'off'],
      [{ linksConfigured: false }, 'no_links'],
      [{ status: 'handed' }, 'not_completed'],
      [{ status: 'refund_pending' }, 'not_completed'],
      [{ completedAt: null }, 'not_completed'],
      [{ now: new Date(completedAt.getTime() + 3 * DAY - 1) }, 'not_yet'],
      [{ linkOpened: true }, 'link_opened'],
      [{ claimAfterHandover: true }, 'claim'],
      [{ hasMessenger: false }, 'no_messenger'],
      [
        { now: new Date(completedAt.getTime() + (3 + REVIEW_REMINDER_GRACE_DAYS) * DAY + 1) },
        'too_late',
      ],
    ];
    for (const [change, verdict] of cases) {
      expect(reviewReminderVerdict({ ...due, ...change }), JSON.stringify(change)).toBe(verdict);
      expect(reviewReminderDue({ ...due, ...change })).toBe(false);
    }
  });

  it('follows reviews.reminder_days', () => {
    const later = { ...due, reminderDays: 5 };
    expect(reviewReminderVerdict(later)).toBe('not_yet');
    expect(
      reviewReminderVerdict({ ...later, now: new Date(completedAt.getTime() + 5 * DAY) }),
    ).toBe('due');
  });
});
