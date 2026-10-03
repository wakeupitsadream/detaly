// Admin VIN request actions (phase 1C, server/admin/vin-actions-handler.ts): Basic auth in
// src/proxy.ts and again in the handler.
import { handleAdminVinAction } from '@/server/admin/vin-actions-handler';
import { getDb } from '@/server/db';
import { demoNotFound } from '@/server/demo/responses';
import { getEngineDeps } from '@/server/engine';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { getSupplier } from '@/server/supplier';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (isDemoMode()) return demoNotFound();
  const { id } = await params;
  const supplier = getSupplier();
  return handleAdminVinAction(request, id, {
    db: getDb(),
    env: serverEnv(),
    supplier: { rossko: supplier.rossko, settings: supplier.settings },
    logger: getLogger(),
    nudge: () => getEngineDeps().nudge?.(),
  });
}
