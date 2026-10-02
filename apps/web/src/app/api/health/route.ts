import { handleHealthRequest } from '@/server/api/health-handler';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { createHealthDeps, DEMO_HEALTH } from '@/server/health';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { getRedis } from '@/server/redis';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  if (isDemoMode()) {
    return Promise.resolve(
      Response.json(DEMO_HEALTH, { headers: { 'Cache-Control': 'no-store, max-age=0' } }),
    );
  }
  return handleHealthRequest(() =>
    createHealthDeps({
      env: serverEnv(),
      db: getDb(),
      redis: getRedis(),
      onError: (error, check) =>
        getLogger().warn(
          { err: error instanceof Error ? error.message : String(error), check },
          'health check failed',
        ),
    }),
  );
}
