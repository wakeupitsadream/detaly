// S3-compatible FileStore (Timeweb / Yandex Object Storage), SigV4 through aws4fetch, path-style
// URLs `<endpoint>/<bucket>/<prefix><key>` (docs/phase-1c-implementation.md decision С18,
// section 6). VERIFY: path-style vs virtual-host, the region name (ru-1 / ru-central1) and
// UNSIGNED-PAYLOAD with the provider (docs/external.md, section 8).
//
// - aws4fetch is imported lazily inside the first call: the demo build never executes it.
// - Only signing comes from aws4fetch; requests go through the injected `fetch` (tests use msw on
//   the global one) with a timeout, and one retry on 5xx, 429 or a network error (PUT, GET and
//   DELETE of a key are idempotent).
// - Error messages carry the method and the HTTP status only: never the object key (it names a
//   client's request or order), the endpoint credentials or the response body.
import type { AwsClient } from 'aws4fetch';
import { assertFileKey } from './keys';
import type { FileObject, FileStore } from './types';

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

export const S3_TIMEOUT_MS = 15_000;
/** Extra attempts after a 5xx, 429 or network failure. */
const S3_RETRIES = 1;
const JPEG = 'image/jpeg';

/** A failed S3 call. The message never contains the key, the URL or credentials. */
export class S3FileStoreError extends Error {
  readonly method: string;
  /** HTTP status, or null for a network error / timeout. */
  readonly status: number | null;
  readonly timeout: boolean;

  constructor(method: string, status: number | null, timeout = false) {
    super(
      timeout
        ? `S3 ${method} timed out`
        : status === null
          ? `S3 ${method} failed: network error`
          : `S3 ${method} failed: HTTP ${status}`,
    );
    this.name = 'S3FileStoreError';
    this.method = method;
    this.status = status;
    this.timeout = timeout;
  }
}

/** Encodes every path segment (keys are [a-z0-9-/.] already; the prefix may hold anything). */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/u, '');
  return trimmed === '' || trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export function createS3FileStore(options: S3FileStoreOptions): FileStore {
  const base = new URL(options.endpoint);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error('S3 endpoint must be an http(s) URL');
  }
  if (options.bucket === '' || options.bucket.includes('/')) {
    throw new Error('S3 bucket name is invalid');
  }
  const root = `${base.origin}${base.pathname.replace(/\/+$/u, '')}/${encodeURIComponent(options.bucket)}/`;
  const prefix = normalizePrefix(options.prefix);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? S3_TIMEOUT_MS;

  let client: Promise<AwsClient> | null = null;
  function signer(): Promise<AwsClient> {
    client ??= import('aws4fetch').then(
      ({ AwsClient: Client }) =>
        new Client({
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
          service: 's3',
          region: options.region,
          // Retries are ours (through the injected fetch); aws4fetch's own fetch is unused.
          retries: 0,
        }),
    );
    return client;
  }

  function urlOf(key: string): string {
    assertFileKey(key);
    return root + encodePath(prefix + key);
  }

  async function send(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    init: { body?: Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const url = urlOf(key);
    const aws = await signer();
    let lastError: S3FileStoreError | null = null;
    for (let attempt = 0; attempt <= S3_RETRIES; attempt += 1) {
      // Signed per attempt: X-Amz-Date must be fresh.
      const request = await aws.sign(url, {
        method,
        headers: init.headers,
        body: init.body as RequestInit['body'],
      });
      let response: Response;
      try {
        response = await doFetch(request, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        lastError = new S3FileStoreError(method, null, isTimeout(error));
        continue;
      }
      if (response.status >= 500 || response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        lastError = new S3FileStoreError(method, response.status);
        continue;
      }
      return response;
    }
    throw lastError ?? new S3FileStoreError(method, null);
  }

  return {
    kind: 's3',

    async put(key, bytes, contentType = JPEG) {
      const response = await send('PUT', key, {
        body: bytes,
        headers: { 'Content-Type': contentType },
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new S3FileStoreError('PUT', response.status);
    },

    async get(key): Promise<FileObject | null> {
      const response = await send('GET', key);
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new S3FileStoreError('GET', response.status);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { bytes, contentType: response.headers.get('content-type') ?? JPEG };
    },

    async delete(key) {
      const response = await send('DELETE', key);
      await response.body?.cancel().catch(() => undefined);
      // S3 answers 204 for a missing key too; some providers answer 404.
      if (response.ok || response.status === 404) return;
      throw new S3FileStoreError('DELETE', response.status);
    },
  };
}
