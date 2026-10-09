import {
  DEFAULT_FIT_CHECK_SLA_MINUTES,
  DEFAULT_MAX_MARKUP_BP,
  DEFAULT_MIN_MARKUP_BP,
  DEFAULT_REVIEW_MAX_AGE_DAYS,
  DEFAULT_REVIEW_MIN_COUNT,
  DEFAULT_REVIEW_REMINDER_DAYS,
  FIT_CHECK_SLA_KEY,
  REVIEW_SNAPSHOT_KEY,
} from '@detaly/domain';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env';
import { pctToBp, settingsDefaultsFromEnv } from '../src/settings-defaults';
import { minimalEnvSource } from '../src/testing';

describe('settingsDefaultsFromEnv', () => {
  it('converts env defaults into settings values (kopecks, basis points)', () => {
    const settings = settingsDefaultsFromEnv(parseEnv(minimalEnvSource()));
    expect(settings['pricing.markup_rules']).toEqual([
      { fromKop: 0, toKop: 100000, localBp: 2800, orderBp: 2800 },
      { fromKop: 100000, toKop: 500000, localBp: 2800, orderBp: 2800 },
      { fromKop: 500000, toKop: null, localBp: 2800, orderBp: 2800 },
    ]);
    expect(settings['order.on_pickup_max_total_kop']).toBe(1_500_000);
    expect(settings['reminder.days']).toEqual([3, 6, 9]);
    expect(settings['pricing.min_order_total_kop']).toBe(0);
    expect(settings['courier.fee_kop']).toBe(0);
    expect(settings['rossko.prepay_invoice']).toBe(false);
    expect(settings['no_show.limit']).toBe(2);
    expect(settings['approval.timeout_h']).toBe(24);
    // Step 2: no group adjustments by default, the floor and the ceiling of the domain.
    expect(settings['pricing.group_adjustments']).toEqual([]);
    expect(settings['pricing.min_markup_bp']).toBe(DEFAULT_MIN_MARKUP_BP);
    expect(settings['pricing.max_markup_bp']).toBe(DEFAULT_MAX_MARKUP_BP);
    // Step 3: the review reminder 3 days after completed, the rating line from 5 reviews and a
    // snapshot of at most 45 days; the snapshot itself is never seeded (the admin writes it).
    expect(settings['reviews.reminder_days']).toBe(DEFAULT_REVIEW_REMINDER_DAYS);
    expect(settings['reviews.reminder_days']).toBe(3);
    expect(settings['reviews.min_count']).toBe(DEFAULT_REVIEW_MIN_COUNT);
    expect(settings['reviews.min_count']).toBe(5);
    expect(settings['reviews.max_age_days']).toBe(DEFAULT_REVIEW_MAX_AGE_DAYS);
    expect(settings['reviews.max_age_days']).toBe(45);
    expect(Object.keys(settings)).not.toContain(REVIEW_SNAPSHOT_KEY);
    // Step 4: the master answers a fit check within 60 minutes of working time.
    expect(settings[FIT_CHECK_SLA_KEY]).toBe(DEFAULT_FIT_CHECK_SLA_MINUTES);
    expect(settings['fit_check.sla_minutes']).toBe(60);
  });

  it('converts percents with decimals exactly', () => {
    expect(pctToBp(28)).toBe(2800);
    expect(pctToBp(27.5)).toBe(2750);
    expect(pctToBp(0.07)).toBe(7);
  });
});
