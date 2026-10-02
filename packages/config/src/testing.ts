/**
 * Test helpers shared by all workspaces (import from '@detaly/config/testing').
 *
 * Integration tests run against the real PostgreSQL 16 and Redis 7 started by
 * `scripts/dev-db.sh up`; load their URLs with `eval "$(scripts/dev-db.sh env)"`.
 * Redis is shared between worktrees: always prefix keys with testKeyPrefix() and clean up
 * with deleteKeysByPrefix(); FLUSHDB/FLUSHALL are forbidden.
 */
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const DEV_REDIS_TEST_URL = 'redis://127.0.0.1:56379/1';

/** REDIS_URL_TEST, falling back to the dev-db.sh default. */
export function testRedisUrl(): string {
  return process.env.REDIS_URL_TEST || DEV_REDIS_TEST_URL;
}

/** DATABASE_URL_TEST (per-worktree database). Throws with a hint when it is not set. */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error(
      'DATABASE_URL_TEST is not set: run `scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"`',
    );
  }
  return url;
}

/** Unique key prefix for one test file or case: `test:<uuid>:`. */
export function testKeyPrefix(): string {
  return `test:${randomUUID()}:`;
}

/** Deletes every key starting with `prefix` (SCAN + UNLINK). Refuses an empty prefix. */
export async function deleteKeysByPrefix(redis: Redis, prefix: string): Promise<number> {
  if (!prefix.startsWith('test:')) {
    throw new Error(`refusing to delete keys outside the test namespace: "${prefix}"`);
  }
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await redis.unlink(...keys);
  } while (cursor !== '0');
  return deleted;
}

/** Minimal env source that passes parseEnv(); override what the test needs. */
export function minimalEnvSource(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgres://detaly:detaly@127.0.0.1:55432/detaly',
    REDIS_URL: 'redis://127.0.0.1:56379/0',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    ...overrides,
  };
}
