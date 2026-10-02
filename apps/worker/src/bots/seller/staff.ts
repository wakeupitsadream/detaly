// Who may talk to the seller bot: active rows of the `staff` table with a Telegram id.
// The set is cached for 60 s, so deactivating someone in the admin takes effect within a minute.
import type { Logger } from '@detaly/config';
import { staff, type Database } from '@detaly/db';

export const STAFF_CACHE_TTL_MS = 60_000;
/** After a failed reload the previous set is reused for this long before the next attempt. */
export const STAFF_RETRY_AFTER_FAILURE_MS = 10_000;

export type IsStaff = (tgUserId: number) => Promise<boolean>;

/** Telegram ids of active staff. The table is tiny, so it is read whole. */
export async function loadStaffTgIds(db: Pick<Database, 'select'>): Promise<Set<number>> {
  const rows = await db.select({ tgUserId: staff.tgUserId, isActive: staff.isActive }).from(staff);
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.isActive && row.tgUserId !== null) ids.add(row.tgUserId);
  }
  return ids;
}

export interface StaffCacheOptions {
  load: () => Promise<Set<number>>;
  ttlMs?: number;
  retryAfterFailureMs?: number;
  /** Clock in epoch ms (tests). */
  now?: () => number;
  logger?: Pick<Logger, 'warn' | 'error'>;
}

export interface StaffCache {
  isStaff: IsStaff;
  /** Drops the cached set; the next call reloads it. */
  invalidate(): void;
}

/**
 * Caches the staff set for `ttlMs` with a single in-flight reload. When a reload fails the
 * previous set stays in use (logged) and the next attempt waits `retryAfterFailureMs`; with no previous set everyone is treated as a stranger,
 * so the bot stays silent rather than answering an unverified user.
 */
export function createStaffCache({
  load,
  ttlMs = STAFF_CACHE_TTL_MS,
  retryAfterFailureMs = STAFF_RETRY_AFTER_FAILURE_MS,
  now = Date.now,
  logger,
}: StaffCacheOptions): StaffCache {
  let ids: Set<number> | null = null;
  let loadedAt = 0;
  let inflight: Promise<Set<number> | null> | null = null;

  const refresh = (): Promise<Set<number> | null> => {
    inflight ??= load()
      .then((fresh) => {
        ids = fresh;
        loadedAt = now();
        return fresh;
      })
      .catch((error: unknown) => {
        if (ids) {
          // Without this every message would wait for the failing database again
          // (postgres-js waits up to its connect timeout).
          loadedAt = now() - ttlMs + retryAfterFailureMs;
          logger?.warn({ err: error }, 'staff reload failed, using the previous list');
        } else {
          logger?.error({ err: error }, 'staff load failed, treating everyone as a stranger');
        }
        return ids;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    async isStaff(tgUserId) {
      const current = ids && now() - loadedAt < ttlMs ? ids : await refresh();
      return current?.has(tgUserId) ?? false;
    },
    invalidate() {
      ids = null;
      loadedAt = 0;
    },
  };
}
