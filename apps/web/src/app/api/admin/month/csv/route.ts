// «Скачать CSV» of the act (step 7, server/admin/month-handler.ts): Basic auth in src/proxy.ts
// and again in the handler.
import { handleAdminMonthCsv } from '@/server/admin/month-handler';
import { getDb } from '@/server/db';
import { demoNotFound } from '@/server/demo/responses';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (isDemoMode()) return demoNotFound();
  return handleAdminMonthCsv(request, { db: getDb(), env: serverEnv(), logger: getLogger() });
}
