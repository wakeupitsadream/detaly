// «Записаться» on /o/<token> (docs/phase-1c-implementation.md section 10.2, decision С6). The
// IP rate limit `install` belongs to src/proxy.ts.
import { demoNotFound } from '@/server/demo/responses';
import { getEngineDeps } from '@/server/engine';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { handleInstallRequest } from '@/server/orders/install-handler';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  // DEMO_MODE: the proxy answers /api/orders/demo/install with 303 /o/demo?demo=install.
  if (isDemoMode()) return demoNotFound();
  const { token } = await params;
  const engine = getEngineDeps();
  return handleInstallRequest(request, token, {
    engine,
    appBaseUrl: engine.env.APP_BASE_URL,
    logger: getLogger(),
  });
}
