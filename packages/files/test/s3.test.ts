// createS3FileStore against an msw S3 double: SigV4 headers, path-style URLs with the prefix,
// GET 404 -> null, DELETE 404 -> ok, 5xx -> one retry then an error without the key, timeout.
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFileStoreFromEnv, createS3FileStore, FileKeyError, newFileKey } from '../src';

const ENDPOINT = 'https://s3.example.test';
const BUCKET = 'detaly-files';
const ACCESS_KEY = 'AKIATESTACCESSKEY';
const SECRET_KEY = 'test-secret-key-never-in-errors';

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  contentSha: string | null;
  amzDate: string | null;
  contentType: string | null;
  body: Uint8Array;
}

const objects = new Map<string, Uint8Array>();
let seen: Seen[] = [];
/** Status codes to answer before the real handler (consumed one per request). */
let failures: number[] = [];

const server = setupServer(
  http.all(`${ENDPOINT}/*`, async ({ request }) => {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    seen.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get('authorization'),
      contentSha: request.headers.get('x-amz-content-sha256'),
      amzDate: request.headers.get('x-amz-date'),
      contentType: request.headers.get('content-type'),
      body,
    });
    const failure = failures.shift();
    if (failure !== undefined) {
      return new HttpResponse(`<Error><Key>${url.pathname}</Key></Error>`, { status: failure });
    }
    switch (request.method) {
      case 'PUT':
        objects.set(url.pathname, body);
        return new HttpResponse(null, { status: 200 });
      case 'GET': {
        const object = objects.get(url.pathname);
        return object
          ? new HttpResponse(object, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
          : new HttpResponse('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      }
      case 'DELETE':
        objects.delete(url.pathname);
        return new HttpResponse(null, { status: 204 });
      default:
        return new HttpResponse(null, { status: 405 });
    }
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  objects.clear();
  seen = [];
  failures = [];
});
afterAll(() => server.close());

function store(overrides: Partial<Parameters<typeof createS3FileStore>[0]> = {}) {
  return createS3FileStore({
    endpoint: ENDPOINT,
    region: 'ru-1',
    bucket: BUCKET,
    prefix: 'files/',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    ...overrides,
  });
}

const owner = uuidv7();

describe('createS3FileStore', () => {
  it('PUT, GET and DELETE path-style under the prefix, signed with SigV4 (UNSIGNED-PAYLOAD)', async () => {
    const s3 = store();
    expect(s3.kind).toBe('s3');
    const key = newFileKey('vin', owner);
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    await s3.put(key, bytes);

    const put = seen[0] as Seen;
    expect(put.method).toBe('PUT');
    expect(put.path).toBe(`/${BUCKET}/files/${key}`);
    expect(put.authorization).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/\\d{8}/ru-1/s3/aws4_request, ` +
          'SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$',
      ),
    );
    expect(put.authorization).toContain('x-amz-content-sha256');
    expect(put.authorization).not.toContain(SECRET_KEY);
    expect(put.contentSha).toBe('UNSIGNED-PAYLOAD');
    expect(put.amzDate).toMatch(/^\d{8}T\d{6}Z$/);
    expect(put.contentType).toBe('image/jpeg');
    expect([...put.body]).toEqual([...bytes]);

    const got = await s3.get(key);
    expect(got).not.toBeNull();
    expect([...(got?.bytes ?? [])]).toEqual([...bytes]);
    expect(got?.contentType).toBe('image/jpeg');
    expect(seen[1]?.method).toBe('GET');
    expect(seen[1]?.authorization).toMatch(/^AWS4-HMAC-SHA256 /);

    await s3.delete(key);
    expect(seen[2]).toMatchObject({ method: 'DELETE', path: `/${BUCKET}/files/${key}` });
    expect(await s3.get(key)).toBeNull();
  });

  it('GET of a missing object -> null; DELETE of a missing object (404) -> ok', async () => {
    const s3 = store();
    const key = newFileKey('order', owner);
    expect(await s3.get(key)).toBeNull();
    failures = [404];
    await expect(s3.delete(key)).resolves.toBeUndefined();
  });

  it('a prefix without a slash, an endpoint with a path and an empty prefix', async () => {
    const key = newFileKey('claim', owner);
    await store({ prefix: 'photos' }).put(key, new Uint8Array([1]));
    await store({ endpoint: `${ENDPOINT}/storage/`, prefix: '' }).put(key, new Uint8Array([1]));
    expect(seen.map((s) => s.path)).toEqual([
      `/${BUCKET}/photos/${key}`,
      `/storage/${BUCKET}/${key}`,
    ]);
  });

  it('5xx: one retry; still failing -> an error naming method and status, no key or secrets', async () => {
    const s3 = store();
    const key = newFileKey('vin', owner);
    failures = [503];
    await s3.put(key, new Uint8Array([1]));
    expect(seen.map((s) => s.method)).toEqual(['PUT', 'PUT']);

    failures = [500, 502];
    const error = await s3.get(key).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).message} ${String(error)} ${JSON.stringify(error)}`;
    expect((error as Error).message).toBe('S3 GET failed: HTTP 502');
    expect(error).toMatchObject({ name: 'S3FileStoreError', method: 'GET', status: 502 });
    for (const secret of [key, owner, ACCESS_KEY, SECRET_KEY, BUCKET, ENDPOINT]) {
      expect(text).not.toContain(secret);
    }
  });

  it('4xx other than 404 fails at once (no retry)', async () => {
    const s3 = store();
    failures = [403];
    await expect(s3.put(newFileKey('vin', owner), new Uint8Array([1]))).rejects.toThrow(
      'S3 PUT failed: HTTP 403',
    );
    expect(seen).toHaveLength(1);
  });

  it('a hanging provider times out (timeoutMs), without the key in the error', async () => {
    // A provider that never answers: every attempt hangs until the store's own timeout aborts
    // it. An injected fetch, not the msw double: msw intercepts undici at the socket level, and
    // under load a request whose connection undici opens while an aborted one is torn down can
    // escape the interception and go to the real DNS (getaddrinfo ENOTFOUND s3.example.test).
    // That attempt then fails as a network error instead of the timeout under test (seen once in
    // four full `pnpm test` runs, in about a quarter of the gets of a loaded probe).
    let attempts = 0;
    const hanging: typeof fetch = (_input, init) => {
      attempts += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const key = newFileKey('vin', owner);
    const error = await store({ timeoutMs: 50, fetch: hanging })
      .get(key)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'S3FileStoreError', timeout: true, status: null });
    expect((error as Error).message).toBe('S3 GET timed out');
    expect((error as Error).message).not.toContain(key);
    // The timeout is retried once, as a network error or a 5xx.
    expect(attempts).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('an injected fetch is used instead of the global one', async () => {
    const calls: string[] = [];
    const s3 = store({
      fetch: async (input) => {
        calls.push(input instanceof Request ? input.method : 'GET');
        return new Response(null, { status: 404 });
      },
    });
    expect(await s3.get(newFileKey('vin', owner))).toBeNull();
    expect(calls).toEqual(['GET']);
    expect(seen).toHaveLength(0);
  });

  it('keys outside the mask never reach the network', async () => {
    const s3 = store();
    for (const key of ['../etc/passwd', `vin/${owner}/../x.jpg`, `vin/${owner}`]) {
      await expect(s3.put(key, new Uint8Array([1]))).rejects.toBeInstanceOf(FileKeyError);
      await expect(s3.get(key)).rejects.toBeInstanceOf(FileKeyError);
      await expect(s3.delete(key)).rejects.toBeInstanceOf(FileKeyError);
    }
    expect(seen).toHaveLength(0);
  });

  it('createFileStoreFromEnv builds it for FILES_STORAGE=s3 (bucket FILES_S3_BUCKET, else S3_BUCKET)', async () => {
    const s3 = createFileStoreFromEnv({
      FILES_STORAGE: 's3',
      FILES_LOCAL_DIR: 'var/files',
      FILES_S3_BUCKET: undefined,
      FILES_S3_PREFIX: 'files/',
      S3_ENDPOINT: ENDPOINT,
      S3_REGION: undefined,
      S3_BUCKET: BUCKET,
      S3_KEY: ACCESS_KEY,
      S3_SECRET: SECRET_KEY,
    });
    expect(s3.kind).toBe('s3');
    const key = newFileKey('vin', owner);
    await s3.put(key, new Uint8Array([7]));
    expect(seen[0]?.path).toBe(`/${BUCKET}/files/${key}`);
    expect(seen[0]?.authorization).toContain('/ru-1/s3/aws4_request');
  });
});
