// Client cancellation confirmed by the last 4 phone digits. The IP rate limit (5 per hour) is
// applied in src/proxy.ts before this handler runs; the per-order attempt counter is here.
import { getEngineDeps } from '@/server/engine';
import { getLogger } from '@/server/logger';
import { handleCancelRequest } from '@/server/orders/cancel-handler';
import { getRedis } from '@/server/redis';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const engine = getEngineDeps();
  return handleCancelRequest(request, token, {
    db: engine.db,
    env: engine.env,
    ...(engine.nudge ? { nudge: engine.nudge } : {}),
    redis: getRedis(),
    appBaseUrl: engine.env.APP_BASE_URL,
    logger: getLogger(),
  });
}
