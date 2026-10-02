import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import sharp from 'sharp';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFileStoreFromEnv,
  createLocalFileStore,
  createMemoryFileStore,
  createNoFileStore,
  FileKeyError,
  FilesDisabledError,
  ImageRejectedError,
  ingestImage,
  isFileKey,
  newFileKey,
  type FileStore,
} from '../src';

const OWNER = uuidv7();
const BAD_KEYS = [
  '../etc/passwd',
  `order/${OWNER}/../../../etc/passwd`,
  `order/${OWNER}/${uuidv7()}.png`,
  `order/${OWNER}`,
  `/order/${OWNER}/${uuidv7()}.jpg`,
  `orders/${OWNER}/${uuidv7()}.jpg`,
  `order/${OWNER.toUpperCase()}/${uuidv7()}.jpg`,
  `order/${OWNER}/${uuidv7()}.jpg/..`,
  '',
];

describe('keys', () => {
  it('newFileKey makes `<scope>/<owner>/<uuid>.jpg` that isFileKey accepts', () => {
    for (const scope of ['vin', 'claim', 'order'] as const) {
      const key = newFileKey(scope, OWNER);
      expect(key).toMatch(new RegExp(`^${scope}/${OWNER}/[0-9a-f-]{36}\\.jpg$`));
      expect(isFileKey(key)).toBe(true);
    }
    expect(newFileKey('order', OWNER.toUpperCase()).startsWith(`order/${OWNER}/`)).toBe(true);
    expect(newFileKey('vin', OWNER)).not.toBe(newFileKey('vin', OWNER));
  });

  it('rejects owners that are not uuids and keys outside the mask', () => {
    expect(() => newFileKey('order', '../x')).toThrow(FileKeyError);
    expect(() => newFileKey('files' as never, OWNER)).toThrow(FileKeyError);
    for (const key of BAD_KEYS) expect(isFileKey(key), key).toBe(false);
    expect(isFileKey(42)).toBe(false);
  });
});

async function exerciseStore(store: FileStore): Promise<void> {
  const key = newFileKey('vin', OWNER);
  expect(await store.get(key)).toBeNull();
  await store.put(key, new Uint8Array([1, 2, 3]));
  expect(await store.get(key)).toEqual({
    bytes: new Uint8Array([1, 2, 3]),
    contentType: 'image/jpeg',
  });
  // overwrite
  await store.put(key, new Uint8Array([4, 5]));
  expect((await store.get(key))?.bytes).toEqual(new Uint8Array([4, 5]));
  await store.delete(key);
  expect(await store.get(key)).toBeNull();
  // deleting a missing object is fine
  await store.delete(key);
  for (const bad of BAD_KEYS) {
    await expect(store.put(bad, new Uint8Array([1])), bad).rejects.toBeInstanceOf(FileKeyError);
    await expect(store.get(bad), bad).rejects.toBeInstanceOf(FileKeyError);
    await expect(store.delete(bad), bad).rejects.toBeInstanceOf(FileKeyError);
  }
}

describe('memory store', () => {
  it('puts, gets, overwrites and deletes; refuses keys outside the mask', async () => {
    const store = createMemoryFileStore();
    expect(store.kind).toBe('memory');
    await exerciseStore(store);
    const key = newFileKey('claim', OWNER);
    await store.put(key, new Uint8Array([9]));
    expect(store.keys()).toEqual([key]);
  });

  it('keeps its own copy of the bytes', async () => {
    const store = createMemoryFileStore();
    const key = newFileKey('order', OWNER);
    const bytes = new Uint8Array([1, 2]);
    await store.put(key, bytes);
    bytes[0] = 7;
    expect((await store.get(key))?.bytes).toEqual(new Uint8Array([1, 2]));
  });
});

describe('local store', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'detaly-files-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('puts, gets, overwrites and deletes; refuses keys outside the mask', async () => {
    const store = createLocalFileStore({ dir });
    expect(store.kind).toBe('local');
    await exerciseStore(store);
  });

  it('writes through a temporary file: nothing but the object is left behind', async () => {
    const store = createLocalFileStore({ dir });
    const key = newFileKey('order', OWNER);
    await store.put(key, new Uint8Array([1, 2, 3]));
    const files = await readdir(path.dirname(path.join(dir, key)));
    expect(files).toEqual([path.basename(key)]);
    // nothing was written outside the directory by the refused keys of exerciseStore
    expect((await readdir(dir)).sort()).toEqual(['order', 'vin']);
  });
});

describe('none store', () => {
  it('refuses to store, finds nothing, deletes nothing', async () => {
    const store = createNoFileStore();
    const key = newFileKey('vin', OWNER);
    await expect(store.put(key, new Uint8Array([1]))).rejects.toBeInstanceOf(FilesDisabledError);
    expect(await store.get(key)).toBeNull();
    await expect(store.delete(key)).resolves.toBeUndefined();
  });
});

describe('createFileStoreFromEnv', () => {
  it('builds none by default, local by FILES_LOCAL_DIR, and s3 is a phase 1C wave 2 stub', () => {
    expect(createFileStoreFromEnv(parseEnv(minimalEnvSource())).kind).toBe('none');
    expect(
      createFileStoreFromEnv(
        parseEnv(minimalEnvSource({ FILES_STORAGE: 'local', FILES_LOCAL_DIR: tmpdir() })),
      ).kind,
    ).toBe('local');
    const s3 = parseEnv(
      minimalEnvSource({
        FILES_STORAGE: 's3',
        S3_ENDPOINT: 'https://s3.example.ru',
        S3_KEY: 'key',
        S3_SECRET: 'secret',
        S3_BUCKET: 'bucket',
      }),
    );
    expect(() => createFileStoreFromEnv(s3)).toThrow(/not implemented/);
  });
});

describe('ingestImage', () => {
  const MB = 1024 * 1024;

  /** A JPEG with EXIF: camera model, GPS position, orientation 6 (rotate 90° clockwise). */
  async function photoWithExif(width = 400, height = 300): Promise<Uint8Array> {
    return (
      sharp({
        create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
      })
        // the orientation tag is written by withMetadata; withExif alone does not set it
        .withMetadata({ orientation: 6 })
        .withExifMerge({
          IFD0: { Make: 'TestPhone', Model: 'Secret Model X' },
          IFD3: {
            GPSLatitudeRef: 'N',
            GPSLatitude: '51/1 46/1 0/1',
            GPSLongitudeRef: 'E',
            GPSLongitude: '55/1 6/1 0/1',
          },
        })
        .jpeg()
        .toBuffer()
    );
  }

  it('drops EXIF (GPS, phone model) and applies the orientation', async () => {
    const input = await photoWithExif();
    const inputMeta = await sharp(input).metadata();
    expect(inputMeta.exif).toBeDefined();
    expect(inputMeta.orientation).toBe(6);
    expect(Buffer.from(input).includes('Secret Model X')).toBe(true);

    const out = await ingestImage(input, { maxBytes: 8 * MB });
    expect(out.contentType).toBe('image/jpeg');
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(Buffer.from(out.bytes).includes('Secret Model X')).toBe(false);
    expect(Buffer.from(out.bytes).includes('TestPhone')).toBe(false);
    // orientation 6: a 400x300 landscape sensor image is a 300x400 portrait photo
    expect([out.width, out.height]).toEqual([300, 400]);
    expect([meta.width, meta.height]).toEqual([300, 400]);
  });

  it('fits big photos into 2000 px and never enlarges small ones', async () => {
    const big = await sharp({
      create: { width: 4000, height: 1000, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const out = await ingestImage(big, { maxBytes: 8 * MB });
    expect([out.width, out.height]).toEqual([2000, 500]);
    const small = await ingestImage(await photoWithExif(40, 30), { maxBytes: 8 * MB });
    expect([small.width, small.height]).toEqual([30, 40]);
  });

  it('turns PNG (with transparency) into JPEG', async () => {
    const png = await sharp({
      create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const out = await ingestImage(png, { maxBytes: MB });
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.hasAlpha).toBe(false);
  });

  it('rejects text, SVG, empty and truncated files as not_image', async () => {
    const reason = (bytes: Uint8Array) =>
      ingestImage(bytes, { maxBytes: MB }).then(
        () => 'accepted',
        (error: unknown) => (error instanceof ImageRejectedError ? error.reason : String(error)),
      );
    expect(await reason(new TextEncoder().encode('это не картинка, а текст'))).toBe('not_image');
    expect(
      await reason(
        new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        ),
      ),
    ).toBe('not_image');
    expect(await reason(new Uint8Array())).toBe('not_image');
    const jpeg = await photoWithExif();
    expect(await reason(jpeg.subarray(0, 200))).toBe('not_image');
  });

  it('rejects files over maxBytes as too_large and huge dimensions as too_many_pixels', async () => {
    const jpeg = await photoWithExif();
    await expect(ingestImage(jpeg, { maxBytes: jpeg.byteLength - 1 })).rejects.toMatchObject({
      reason: 'too_large',
    });
    await expect(
      ingestImage(jpeg, { maxBytes: MB, maxPixels: 400 * 300 - 1 }),
    ).rejects.toMatchObject({ reason: 'too_many_pixels' });
  });
});
