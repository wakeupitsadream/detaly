// The forms of /admin/returns and /admin/stock (step 7, server/admin/returns-handler.ts): Basic
// auth in src/proxy.ts and again in the handler; the engine acts as the owner (decision Б19).
import { handleAdminReturnsAction } from '@/server/admin/returns-handler';
import { demoNotFound } from '@/server/demo/responses';
import { getEngineDeps } from '@/server/engine';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (isDemoMode()) return demoNotFound();
  return handleAdminReturnsAction(request, {
    engine: getEngineDeps(),
    env: serverEnv(),
    logger: getLogger(),
  });
}
