// resolveSearchSettings: the `order` block (phase 1A) follows the same rules as the rest:
// a valid database value wins, otherwise the env default the seed would have written.
import { parseEnv } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import { DEFAULT_EXCLUDED_RULES } from '@detaly/domain';
import { describe, expect, it, vi } from 'vitest';
import { createSettingsReader, resolveSearchSettings } from '@/server/settings';

const env = parseEnv(
  minimalEnvSource({
    MIN_ORDER_TOTAL: '1000',
    MIN_MARGIN_RUB: '50',
    ON_PICKUP_MAX_TOTAL: '15000',
    ON_PICKUP_CONFIRM_TTL_H: '24',
    NO_SHOW_LIMIT: '2',
    ORDER_PAYMENT_TTL_MIN: '120',
    COURIER_FEE_RUB: '300',
  }),
);

const ENV_ORDER = {
  minOrderTotalKop: 100_000,
  minMarginKop: 5_000,
  onPickupMaxTotalKop: 1_500_000,
  onPickupConfirmTtlH: 24,
  noShowLimit: 2,
  paymentTtlMin: 120,
  courierFeeKop: 30_000,
  pickupWindowPrepaidDays: 10,
  pickupWindowCodDays: 7,
};

describe('order settings', () => {
  it('default to env values converted to kopecks', () => {
    const settings = resolveSearchSettings(new Map(), env, []);
    expect(settings.order).toEqual(ENV_ORDER);
  });

  it('take valid database values', () => {
    const rows = new Map<string, unknown>([
      ['pricing.min_order_total_kop', 0],
      ['pricing.min_margin_kop', 0],
      ['order.on_pickup_max_total_kop', 2_000_000],
      ['order.on_pickup_confirm_ttl_h', 12],
      ['no_show.limit', 3],
      ['order.payment_ttl_min', 60],
      ['courier.fee_kop', 0],
      ['pickup.window_prepaid_days', 14],
      ['pickup.window_cod_days', 3],
    ]);
    expect(resolveSearchSettings(rows, env, []).order).toEqual({
      minOrderTotalKop: 0,
      minMarginKop: 0,
      onPickupMaxTotalKop: 2_000_000,
      onPickupConfirmTtlH: 12,
      noShowLimit: 3,
      paymentTtlMin: 60,
      courierFeeKop: 0,
      pickupWindowPrepaidDays: 14,
      pickupWindowCodDays: 3,
    });
  });

  it('ignore malformed values', () => {
    const rows = new Map<string, unknown>([
      ['pricing.min_order_total_kop', -1],
      ['pricing.min_margin_kop', '100'],
      ['order.on_pickup_max_total_kop', 1.5],
      ['order.on_pickup_confirm_ttl_h', 0],
      ['no_show.limit', 0],
      ['order.payment_ttl_min', null],
      ['courier.fee_kop', { kop: 1 }],
      ['pickup.window_prepaid_days', 0],
      ['pickup.window_cod_days', '7'],
    ]);
    expect(resolveSearchSettings(rows, env, []).order).toEqual(ENV_ORDER);
  });

  it('are served by the reader, with env defaults when the database fails', async () => {
    const onError = vi.fn();
    const failing = {
      query: {
        settings: { findMany: () => Promise.reject(new Error('db down')) },
        excludedGroups: { findMany: () => Promise.reject(new Error('db down')) },
      },
    };
    const reader = createSettingsReader({
      db: failing as unknown as Parameters<typeof createSettingsReader>[0]['db'],
      env,
      onError,
    });
    const settings = await reader.get();
    expect(settings.fromDatabase).toBe(false);
    expect(settings.order).toEqual(ENV_ORDER);
    expect(settings.excludedRules).toEqual([...DEFAULT_EXCLUDED_RULES]);
    expect(onError).toHaveBeenCalled();
  });
});

describe('pricing settings (step 2, docs/pricing.md)', () => {
  it('resolve the base table, adjustments, floor and ceiling like the worker', () => {
    const settings = resolveSearchSettings(
      new Map<string, unknown>([
        ['pricing.group_adjustments', [{ group: 'filters', localDeltaBp: 300, orderDeltaBp: 0 }]],
        ['pricing.margin_floor_pct', 20],
      ]),
      env,
      [],
    );
    expect(settings.pricing.groupAdjustments).toEqual([
      { group: 'filters', localDeltaBp: 300, orderDeltaBp: 0 },
    ]);
    // 20% of margin needs 25% of markup: above pricing.min_markup_bp (10%)
    expect(settings.pricing.minMarkupBp).toBe(2500);
    expect(settings.pricing.maxMarkupBp).toBe(6000);
    expect(resolveSearchSettings(new Map(), env, []).pricing.groupAdjustments).toEqual([]);
  });
});

describe('createSettingsReader.invalidate', () => {
  function countingDb(values: { adjustments: unknown }) {
    const calls = { count: 0 };
    let release: (() => void) | null = null;
    let hold = false;
    const db = {
      query: {
        settings: {
          findMany: async () => {
            calls.count += 1;
            const snapshot = values.adjustments;
            if (hold) await new Promise<void>((resolve) => (release = resolve));
            return [{ key: 'pricing.group_adjustments', value: snapshot }];
          },
        },
        excludedGroups: { findMany: async () => [] },
      },
    };
    return {
      db: db as unknown as Parameters<typeof createSettingsReader>[0]['db'],
      calls,
      holdNext: () => {
        hold = true;
      },
      release: () => {
        hold = false;
        release?.();
      },
    };
  }

  it('makes the next read go to the database instead of the cache', async () => {
    const values = { adjustments: [] as unknown };
    const fake = countingDb(values);
    const reader = createSettingsReader({ db: fake.db, env, ttlMs: 60_000 });
    expect((await reader.get()).pricing.groupAdjustments).toEqual([]);
    values.adjustments = [{ group: 'body', localDeltaBp: 100, orderDeltaBp: 0 }];
    // cached for a minute
    expect((await reader.get()).pricing.groupAdjustments).toEqual([]);
    expect(fake.calls.count).toBe(1);
    reader.invalidate();
    expect((await reader.get()).pricing.groupAdjustments).toEqual([
      { group: 'body', localDeltaBp: 100, orderDeltaBp: 0 },
    ]);
    expect(fake.calls.count).toBe(2);
  });

  it('a read started before invalidate() does not cache its older values', async () => {
    const values = { adjustments: [] as unknown };
    const fake = countingDb(values);
    const reader = createSettingsReader({ db: fake.db, env, ttlMs: 60_000 });
    fake.holdNext();
    const early = reader.get();
    await vi.waitFor(() => expect(fake.calls.count).toBe(1));
    values.adjustments = [{ group: 'body', localDeltaBp: 100, orderDeltaBp: 0 }];
    reader.invalidate();
    fake.release();
    expect((await early).pricing.groupAdjustments).toEqual([]);
    expect((await reader.get()).pricing.groupAdjustments).toEqual([
      { group: 'body', localDeltaBp: 100, orderDeltaBp: 0 },
    ]);
    expect(fake.calls.count).toBe(2);
  });
});
