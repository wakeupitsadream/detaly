import { handleHealthRequest } from '@/server/api/health-handler';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { createHealthDeps } from '@/server/health';
import { getLogger } from '@/server/logger';
import { getRedis } from '@/server/redis';

export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
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
