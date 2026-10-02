import type { Env } from '@detaly/config';
import { createS3FileStore } from './s3';
import { createLocalFileStore, createNoFileStore } from './stores';
import type { FileStore } from './types';

/** Region when S3_REGION is empty. VERIFY: the provider's region name (docs/external.md). */
export const DEFAULT_S3_REGION = 'ru-1';

export type FilesEnv = Pick<
  Env,
  | 'FILES_STORAGE'
  | 'FILES_LOCAL_DIR'
  | 'FILES_S3_BUCKET'
  | 'FILES_S3_PREFIX'
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_KEY'
  | 'S3_SECRET'
>;

/**
 * The FileStore of FILES_STORAGE: none (default; photos off), local (FILES_LOCAL_DIR) or s3
 * (S3_* credentials, bucket FILES_S3_BUCKET or S3_BUCKET, key prefix FILES_S3_PREFIX). The env
 * schema already guarantees the s3 settings are present when FILES_STORAGE=s3.
 */
export function createFileStoreFromEnv(
  env: FilesEnv,
  options: { fetch?: typeof fetch } = {},
): FileStore {
  switch (env.FILES_STORAGE) {
    case 'none':
      return createNoFileStore();
    case 'local':
      return createLocalFileStore({ dir: env.FILES_LOCAL_DIR });
    case 's3': {
      const bucket = env.FILES_S3_BUCKET ?? env.S3_BUCKET;
      if (!env.S3_ENDPOINT || !env.S3_KEY || !env.S3_SECRET || !bucket) {
        throw new Error('FILES_STORAGE=s3 needs S3_ENDPOINT, S3_KEY, S3_SECRET and a bucket');
      }
      return createS3FileStore({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION ?? DEFAULT_S3_REGION,
        bucket,
        prefix: env.FILES_S3_PREFIX,
        accessKeyId: env.S3_KEY,
        secretAccessKey: env.S3_SECRET,
        fetch: options.fetch,
      });
    }
  }
}
