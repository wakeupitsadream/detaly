// FileStore keys: `<scope>/<owner uuid>/<uuid>.jpg` (FILE_KEY_PATTERN of @detaly/domain, the same
// mask order_photos.s3_key is checked against). Nothing else is accepted, so a key can never walk
// out of its folder ('..', absolute paths, other extensions).
import { FILE_KEY_PATTERN, FILE_KEY_SCOPES, type FileKeyScope } from '@detaly/domain/statuses';
import { v7 as uuidv7 } from 'uuid';
import { FileKeyError } from './types';

const KEY_RE = new RegExp(FILE_KEY_PATTERN);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isFileKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_RE.test(value);
}

/** Throws FileKeyError unless `key` matches the mask. */
export function assertFileKey(key: string): void {
  if (!isFileKey(key)) throw new FileKeyError();
}

/** A new key for a photo of `ownerId` (VIN request, order or claim's order id). */
export function newFileKey(scope: FileKeyScope, ownerId: string): string {
  if (!(FILE_KEY_SCOPES as readonly string[]).includes(scope)) throw new FileKeyError();
  const owner = ownerId.toLowerCase();
  if (!UUID_RE.test(owner)) throw new FileKeyError();
  return `${scope}/${owner}/${uuidv7()}.jpg`;
}
