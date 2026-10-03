// housekeeping/retention, daily at 04:40 Asia/Yekaterinburg (docs/phase-1c-implementation.md
// decision С16, PLAN section 7 item 8): photos of VIN requests older than
// VIN_PHOTO_RETENTION_DAYS are deleted from the FileStore, vin_requests.photos is emptied and
// photos_deleted_at set.
//
// - batches of 100 requests (keyset by id), the whole backlog in one run;
// - every key is deleted on its own: one failed key keeps its request (photos untouched) for the
//   next run, the others are gone already (delete is idempotent);
// - a key outside the FileStore mask cannot exist in the store, a key outside `vin/` is not a
//   VIN photo: both are dropped from the row without touching the store;
// - FILES_STORAGE=none cannot delete anything: requests are left as they are (the objects may
//   still be in the bucket of an earlier configuration), the log says how many wait;
// - idempotent: a second run finds nothing. The log gets counters only (no keys, no ids).
//
// Claim and return photos live with the order (VERIFY: retention period with the lawyer — the
// privacy policy row «Возвраты и претензии» has no term).
import { and, asc, eq, gt, isNull, sql, vinRequests } from '@detaly/db';
import { VIN_PHOTO_RETENTION_DAYS } from '@detaly/domain';
import { FileKeyError } from '@detaly/files';
import type { WorkerDeps } from '../../deps';
import { DAY_MS, notAfter } from './common';

/** FileStore keys of VIN request photos (vin/<id>/<uuid>.jpg). */
const VIN_KEY_PREFIX = 'vin/';

/** Requests per batch. */
export const RETENTION_BATCH = 100;
/** Safety stop of one run (100 000 requests); the next day continues. */
const MAX_BATCHES = 1000;

export interface RetentionResult {
  /** Objects deleted from the FileStore by this run. */
  deleted: number;
  /** Requests whose photos are gone now (photos = [], photos_deleted_at set). */
  requests: number;
  /** Keys that failed to delete (their requests wait for the next run). */
  failed: number;
  /** Requests left alone because FILES_STORAGE=none cannot delete. */
  waiting: number;
}

export async function runRetention(deps: WorkerDeps): Promise<RetentionResult> {
  const now = deps.now();
  const cutoff = new Date(now.getTime() - VIN_PHOTO_RETENTION_DAYS * DAY_MS);
  const result: RetentionResult = { deleted: 0, requests: 0, failed: 0, waiting: 0 };
  // Keyset by id (not by created_at: a JS Date drops the microseconds, a request with a failed
  // key would come back in the next batch of the same run).
  let afterId: string | null = null;

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows: { id: string; photos: string[] }[] = await deps.db
      .select({ id: vinRequests.id, photos: vinRequests.photos })
      .from(vinRequests)
      .where(
        and(
          isNull(vinRequests.photosDeletedAt),
          notAfter(vinRequests.createdAt, cutoff),
          sql`jsonb_array_length(${vinRequests.photos}) > 0`,
          afterId === null ? undefined : gt(vinRequests.id, afterId),
        ),
      )
      .orderBy(asc(vinRequests.id))
      .limit(RETENTION_BATCH);
    if (rows.length === 0) break;
    afterId = (rows.at(-1) as (typeof rows)[number]).id;

    for (const row of rows) {
      if (deps.files.kind === 'none') {
        result.waiting += 1;
        continue;
      }
      let ok = true;
      for (const key of row.photos) {
        // Only VIN photos: a stray order or claim key in the row must not delete that photo.
        if (typeof key !== 'string' || !key.startsWith(VIN_KEY_PREFIX)) continue;
        try {
          await deps.files.delete(key);
          result.deleted += 1;
        } catch (error) {
          if (error instanceof FileKeyError) continue; // never stored: nothing to delete
          ok = false;
          result.failed += 1;
        }
      }
      if (!ok) continue;
      const at = deps.now();
      const updated = await deps.db
        .update(vinRequests)
        .set({ photos: [], photosDeletedAt: at, updatedAt: at })
        .where(and(eq(vinRequests.id, row.id), isNull(vinRequests.photosDeletedAt)))
        .returning({ id: vinRequests.id });
      result.requests += updated.length;
    }
    if (rows.length < RETENTION_BATCH) break;
  }

  if (result.requests > 0 || result.failed > 0 || result.waiting > 0) {
    deps.logger.info({ ...result }, 'retention: VIN photos');
  }
  return result;
}
