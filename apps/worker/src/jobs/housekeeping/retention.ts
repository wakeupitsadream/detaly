// housekeeping/retention, daily at 04:40 Asia/Yekaterinburg (docs/phase-1c-implementation.md
// decision С16): photos of VIN requests older than VIN_PHOTO_RETENTION_DAYS are deleted from the
// FileStore, vin_requests.photos is emptied and photos_deleted_at set. Idempotent; the log gets
// counters only.
//
// Phase 1C wave 1: a stub that deletes nothing. The notify-1c package implements it (batches of
// 100, one failed key keeps its request for the next run).
import type { WorkerDeps } from '../../deps';

export interface RetentionResult {
  /** Objects deleted from the FileStore by this run. */
  deleted: number;
}

export async function runRetention(_deps: WorkerDeps): Promise<RetentionResult> {
  return { deleted: 0 };
}
