// Client cancellation confirmed by the last 4 phone digits. The IP rate limit (5 per hour) is
// applied in src/proxy.ts before this handler runs; the per-order attempt counter is here.
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { handleCancelRequest } from '@/server/orders/cancel-handler';
import { getRedis } from '@/server/redis';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  return handleCancelRequest(request, token, {
    db: getDb(),
    redis: getRedis(),
    appBaseUrl: serverEnv().APP_BASE_URL,
    logger: getLogger(),
  });
}
