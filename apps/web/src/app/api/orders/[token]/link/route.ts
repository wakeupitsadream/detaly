// «Статусы в Telegram» on /o/<token> (docs/phase-1c-implementation.md section 10.1): a one-time
// link token and a 303 to the client bot. The IP rate limit `link` belongs to src/proxy.ts.
import { demoNotFound } from '@/server/demo/responses';
import { getEngineDeps } from '@/server/engine';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { handleLinkRequest } from '@/server/orders/link-handler';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  // DEMO_MODE: the proxy answers /api/orders/demo/link with 303 /o/demo?demo=link and 404 for
  // anything else before this handler runs; this is the second line.
  if (isDemoMode()) return demoNotFound();
  const { token } = await params;
  const engine = getEngineDeps();
  return handleLinkRequest(request, token, {
    engine,
    appBaseUrl: engine.env.APP_BASE_URL,
    logger: getLogger(),
  });
}
