// Admin fit check actions (step 4, server/admin/fit-checks-handler.ts): Basic auth in
// src/proxy.ts and again in the handler.
import { handleAdminFitAction } from '@/server/admin/fit-checks-handler';
import { getDb } from '@/server/db';
import { demoNotFound } from '@/server/demo/responses';
import { getEngineDeps } from '@/server/engine';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { getSupplier } from '@/server/supplier';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (isDemoMode()) return demoNotFound();
  const supplier = getSupplier();
  return handleAdminFitAction(request, {
    db: getDb(),
    env: serverEnv(),
    supplier: { rossko: supplier.rossko, settings: supplier.settings },
    logger: getLogger(),
    nudge: () => getEngineDeps().nudge?.(),
  });
}
