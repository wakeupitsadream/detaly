// YooKassa notifications (decision Б4): IP allowlist on X-Real-IP from Caddy, stored in
// webhook_events with an outbox row for the worker, 200 at once. Not rate limited (allowlist).
import { getEngineDeps } from '@/server/engine';
import { getLogger } from '@/server/logger';
import { handleYooKassaWebhook } from '@/server/payments/webhook-handler';
import { demoNotFound } from '@/server/demo/responses';
import { isDemoMode } from '@/server/mode';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // DEMO_MODE: the route does not exist (the proxy answers 404 first).
  if (isDemoMode()) return demoNotFound();
  const engine = getEngineDeps();
  return handleYooKassaWebhook(request, {
    db: engine.db,
    env: engine.env,
    ...(engine.nudge ? { nudge: engine.nudge } : {}),
    logger: getLogger(),
  });
}
