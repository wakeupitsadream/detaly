import { parseEnv, type Env } from '@detaly/config';
import { minimalEnvSource, testRedisUrl } from '@detaly/config/testing';
import { inject } from 'vitest';

/** Database prepared by test/global-setup.ts; throws with a hint when it is missing. */
export function webDatabaseUrl(): string {
  const url = inject('webDatabaseUrl');
  if (!url) {
    throw new Error(
      'DATABASE_URL_TEST is not set: run `scripts/dev-db.sh up && eval "$(scripts/dev-db.sh env)"`',
    );
  }
  return url;
}

/** Env for integration tests: test database and Redis, fixtures mode. */
export function intEnv(overrides: Record<string, string | undefined> = {}): Env {
  return parseEnv(
    minimalEnvSource({
      DATABASE_URL: webDatabaseUrl(),
      REDIS_URL: testRedisUrl(),
      ROSSKO_MODE: 'fixtures',
      ...overrides,
    }),
  );
}
