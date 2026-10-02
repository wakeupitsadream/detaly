// S3-compatible FileStore (Timeweb / Yandex Object Storage), SigV4 through aws4fetch, path-style
// URLs. Phase 1C wave 1 ships only the contract: the vin-core package implements it
// (docs/phase-1c-implementation.md section 6). VERIFY: path-style vs virtual-host, the region
// name (ru-1 / ru-central1) and UNSIGNED-PAYLOAD with the provider (docs/external.md).
import type { FileStore } from './types';

export interface S3FileStoreOptions {
  /** S3_ENDPOINT, e.g. https://s3.timeweb.cloud */
  endpoint: string;
  /** S3_REGION */
  region: string;
  /** FILES_S3_BUCKET, else S3_BUCKET */
  bucket: string;
  /** FILES_S3_PREFIX, e.g. 'files/' */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch?: typeof fetch;
  /** Request timeout, ms (default 15 000). */
  timeoutMs?: number;
}

export function createS3FileStore(_options: S3FileStoreOptions): FileStore {
  throw new Error('not implemented: phase 1C wave 2');
}
