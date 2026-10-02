// FileStore implementations without a network: none (photos off), memory (tests) and local
// (a directory: dev and e2e; production uses s3).
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertFileKey } from './keys';
import { FilesDisabledError, type FileObject, type FileStore } from './types';

const JPEG = 'image/jpeg';

/** FILES_STORAGE=none: put throws FilesDisabledError, get finds nothing, delete is a no-op. */
export function createNoFileStore(): FileStore {
  return {
    kind: 'none',
    async put() {
      throw new FilesDisabledError();
    },
    async get(key) {
      assertFileKey(key);
      return null;
    },
    async delete(key) {
      assertFileKey(key);
    },
  };
}

export interface MemoryFileStore extends FileStore {
  /** Stored keys, sorted (tests). */
  keys(): string[];
}

/** In-process store for tests (worker test-deps, web route tests). */
export function createMemoryFileStore(): MemoryFileStore {
  const objects = new Map<string, FileObject>();
  return {
    kind: 'memory',
    async put(key, bytes, contentType = JPEG) {
      assertFileKey(key);
      objects.set(key, { bytes: new Uint8Array(bytes), contentType });
    },
    async get(key) {
      assertFileKey(key);
      const object = objects.get(key);
      return object
        ? { bytes: new Uint8Array(object.bytes), contentType: object.contentType }
        : null;
    },
    async delete(key) {
      assertFileKey(key);
      objects.delete(key);
    },
    keys() {
      return [...objects.keys()].sort();
    },
  };
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Files under `dir` (FILES_LOCAL_DIR, resolved against the working directory). A write goes to a
 * temporary file next to the target and is renamed into place, so a reader never sees half a
 * photo. Only JPEG is ever stored, so the content type is not kept.
 */
export function createLocalFileStore(options: { dir: string }): FileStore {
  const root = path.resolve(options.dir);
  const fullPath = (key: string): string => {
    assertFileKey(key);
    const target = path.resolve(root, key);
    // The mask already forbids '..'; this is the belt to its braces.
    if (!target.startsWith(root + path.sep)) throw new Error('file key escapes the directory');
    return target;
  };
  return {
    kind: 'local',
    async put(key, bytes) {
      const target = fullPath(key);
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temp, bytes);
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    async get(key) {
      const target = fullPath(key);
      try {
        return { bytes: new Uint8Array(await readFile(target)), contentType: JPEG };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async delete(key) {
      await rm(fullPath(key), { force: true });
    },
  };
}
