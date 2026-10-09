// «Сохранить», «Опубликовать», «Снять с публикации», «Удалить» of /admin/kits (step 5,
// server/admin/kits-handler.ts): Basic auth in src/proxy.ts and again in the handler.
import { handleAdminKitsAction } from '@/server/admin/kits-handler';
import { getDb } from '@/server/db';
import { demoNotFound } from '@/server/demo/responses';
import { serverEnv } from '@/server/env';
import { invalidateKitCatalog } from '@/server/kits/catalog';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { getSupplier } from '@/server/supplier';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (isDemoMode()) return demoNotFound();
  return handleAdminKitsAction(request, {
    db: getDb(),
    env: serverEnv(),
    supplier: getSupplier(),
    invalidateCatalog: invalidateKitCatalog,
    logger: getLogger(),
  });
}
