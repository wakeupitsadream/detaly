// «Претензия или возврат» on /o/<token> (docs/phase-1c-implementation.md section 10.3): a
// multipart form with up to 3 photos and the last 4 phone digits. The IP rate limit `claim`
// belongs to src/proxy.ts (proxyClientMaxBodySize is raised to 12 MB for these forms).
import { demoNotFound } from '@/server/demo/responses';
import { getEngineDeps } from '@/server/engine';
import { getFileStore, maxUploadBytes } from '@/server/files';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { handleClaimRequest } from '@/server/orders/claim-handler';
import { getRedis } from '@/server/redis';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  // DEMO_MODE: the proxy answers /api/orders/demo/claims with 303 /o/demo?demo=claim without
  // reading the body; no photo or text of a demo visitor is ever accepted.
  if (isDemoMode()) return demoNotFound();
  const { token } = await params;
  const engine = getEngineDeps();
  return handleClaimRequest(request, token, {
    engine,
    redis: getRedis(),
    files: getFileStore(),
    maxFileBytes: maxUploadBytes(),
    appBaseUrl: engine.env.APP_BASE_URL,
    logger: getLogger(),
  });
}
