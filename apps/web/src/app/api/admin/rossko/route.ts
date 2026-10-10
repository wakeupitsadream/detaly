// The settings of /admin/rossko (step 8, server/admin/rossko-handler.ts): Basic auth in
// src/proxy.ts and again in the handler.
import { handleAdminRosskoAction } from '@/server/admin/rossko-handler';
import { getDb } from '@/server/db';
import { demoNotFound } from '@/server/demo/responses';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // DEMO_MODE: the route does not exist (the proxy answers 404 first).
  if (isDemoMode()) return demoNotFound();
  return handleAdminRosskoAction(request, {
    db: getDb(),
    env: serverEnv(),
    logger: getLogger(),
  });
}
