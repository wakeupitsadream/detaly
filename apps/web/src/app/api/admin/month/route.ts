// «Сверить с ЮKassa» and «Сохранить ставки» of the month close (step 7,
// server/admin/month-handler.ts): Basic auth in src/proxy.ts and again in the handler.
import { handleAdminMonthAction } from '@/server/admin/month-handler';
import { getDb } from '@/server/db';
import { demoNotFound } from '@/server/demo/responses';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { getPayments } from '@/server/payments/provider';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // DEMO_MODE: the route does not exist (the proxy answers 404 first).
  if (isDemoMode()) return demoNotFound();
  return handleAdminMonthAction(request, {
    db: getDb(),
    env: serverEnv(),
    provider: getPayments()?.payments ?? null,
    logger: getLogger(),
  });
}
