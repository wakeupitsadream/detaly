/**
 * The photo FileStore of the web process (docs/phase-1c-implementation.md decision С18):
 * FILES_STORAGE none | local | s3. In DEMO_MODE it is always the `none` store (decision С21):
 * nothing is ever written, reads find nothing. Forms show the photo field only when
 * photosEnabled() is true.
 */
import { createFileStoreFromEnv, createNoFileStore, type FileStore } from '@detaly/files';
import { serverEnv } from './env';
import { singleton } from './globals';
import { isDemoMode } from './mode';

export function getFileStore(): FileStore {
  if (isDemoMode()) return createNoFileStore();
  return singleton('file-store', () => createFileStoreFromEnv(serverEnv()));
}

/** Photo uploads are accepted (a store other than `none`, not the demo). */
export function photosEnabled(): boolean {
  return getFileStore().kind !== 'none';
}

/** FILES_MAX_UPLOAD_MB in bytes: the limit of one uploaded photo. */
export function maxUploadBytes(): number {
  return serverEnv().FILES_MAX_UPLOAD_MB * 1024 * 1024;
}
