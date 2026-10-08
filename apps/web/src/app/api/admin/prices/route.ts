// The forms of /admin/prices (step 2, server/admin/prices-handler.ts): Basic auth in
// src/proxy.ts and again in the handler.
import { handleAdminPricesAction } from '@/server/admin/prices-handler';
import { getDb } from '@/server/db';
import { demoNotFound } from '@/server/demo/responses';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { getSupplier } from '@/server/supplier';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (isDemoMode()) return demoNotFound();
  const supplier = getSupplier();
  return handleAdminPricesAction(request, {
    db: getDb(),
    env: serverEnv(),
    supplier: { rossko: supplier.rossko, settings: supplier.settings },
    logger: getLogger(),
  });
}
