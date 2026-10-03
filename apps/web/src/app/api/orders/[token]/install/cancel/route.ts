// «Отменить запись» on /o/<token> (decision С6: the client, not later than 2 hours before the
// slot). The IP rate limit `install` belongs to src/proxy.ts.
import { demoNotFound } from '@/server/demo/responses';
import { getEngineDeps } from '@/server/engine';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { handleInstallCancel } from '@/server/orders/install-handler';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  if (isDemoMode()) return demoNotFound();
  const { token } = await params;
  const engine = getEngineDeps();
  return handleInstallCancel(request, token, {
    engine,
    appBaseUrl: engine.env.APP_BASE_URL,
    logger: getLogger(),
  });
}
