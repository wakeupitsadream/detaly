// Admin photos (phase 1C, server/admin/files-handler.ts): Basic auth in src/proxy.ts and again
// in the handler; no-store.
import { handleAdminFile } from '@/server/admin/files-handler';
import { demoNotFound } from '@/server/demo/responses';
import { serverEnv } from '@/server/env';
import { getFileStore } from '@/server/files';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  if (isDemoMode()) return demoNotFound();
  const { key } = await params;
  return handleAdminFile(request, key, {
    env: serverEnv(),
    files: getFileStore(),
    logger: getLogger(),
  });
}
