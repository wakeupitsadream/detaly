/**
 * Server env: parsed lazily on first use (never at module top level), so `next build` does
 * not need DATABASE_URL, REDIS_URL or SESSION_SECRET.
 */
import { getEnv, type Env } from '@detaly/config';

export type { Env };

export function serverEnv(): Env {
  return getEnv();
}
