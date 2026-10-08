// «Сохранить поправки» of /admin/pricing (step 2, server/admin/pricing-handler.ts): Basic auth
// in src/proxy.ts and again in the handler.
import { handleAdminPricingAction } from '@/server/admin/pricing-handler';
import { getDb } from '@/server/db';
import { demoNotFound } from '@/server/demo/responses';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { getSupplier } from '@/server/supplier';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (isDemoMode()) return demoNotFound();
  return handleAdminPricingAction(request, {
    db: getDb(),
    env: serverEnv(),
    invalidateSettings: () => getSupplier().settings.invalidate(),
    logger: getLogger(),
  });
}
