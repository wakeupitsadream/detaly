// YooKassa notifications (decision Б4): IP allowlist on X-Real-IP from Caddy, stored in
// webhook_events with an outbox row for the worker, 200 at once. Not rate limited (allowlist).
import { getEngineDeps } from '@/server/engine';
import { getLogger } from '@/server/logger';
import { handleYooKassaWebhook } from '@/server/payments/webhook-handler';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const engine = getEngineDeps();
  return handleYooKassaWebhook(request, {
    db: engine.db,
    env: engine.env,
    ...(engine.nudge ? { nudge: engine.nudge } : {}),
    logger: getLogger(),
  });
}
