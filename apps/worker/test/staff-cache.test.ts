import { describe, expect, it, vi } from 'vitest';
import { createStaffCache, STAFF_CACHE_TTL_MS } from '../src/bots/seller/staff';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createStaffCache', () => {
  it('caches the staff set for 60 s', async () => {
    const c = clock();
    const load = vi.fn(async () => new Set([1, 2]));
    const cache = createStaffCache({ load, now: c.now });

    expect(STAFF_CACHE_TTL_MS).toBe(60_000);
    expect(await cache.isStaff(1)).toBe(true);
    expect(await cache.isStaff(3)).toBe(false);
    c.advance(59_999);
    expect(await cache.isStaff(2)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);

    c.advance(1);
    load.mockResolvedValueOnce(new Set([3]));
    expect(await cache.isStaff(1)).toBe(false);
    expect(await cache.isStaff(3)).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('runs a single load for concurrent callers', async () => {
    let resolve!: (ids: Set<number>) => void;
    const load = vi.fn(
      () =>
        new Promise<Set<number>>((r) => {
          resolve = r;
        }),
    );
    const cache = createStaffCache({ load });
    const pending = Promise.all([cache.isStaff(1), cache.isStaff(2), cache.isStaff(3)]);
    resolve(new Set([2]));
    expect(await pending).toEqual([false, true, false]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('treats everyone as a stranger when the first load fails', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const cache = createStaffCache({
      load: async () => {
        throw new Error('db down');
      },
      logger,
    });
    expect(await cache.isStaff(1)).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous set when a reload fails', async () => {
    const c = clock();
    const logger = { warn: vi.fn(), error: vi.fn() };
    const load = vi.fn(async () => new Set([1]));
    const cache = createStaffCache({ load, now: c.now, logger });
    expect(await cache.isStaff(1)).toBe(true);

    c.advance(STAFF_CACHE_TTL_MS);
    load.mockRejectedValueOnce(new Error('db down'));
    expect(await cache.isStaff(1)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('reloads after invalidate()', async () => {
    const load = vi.fn(async () => new Set([1]));
    const cache = createStaffCache({ load });
    await cache.isStaff(1);
    cache.invalidate();
    await cache.isStaff(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
