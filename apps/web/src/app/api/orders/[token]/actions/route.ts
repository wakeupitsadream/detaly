// Client decisions on /o/<token> (decision Б24): «Подтверждаю», «Согласен», «Оплатить заранее»
// by the link token; «Вернуть деньги», «Отказаться от заказа», «Отменить позицию» also with the
// last 4 phone digits. The IP rate limit belongs to src/proxy.ts.
import { getEngineDeps } from '@/server/engine';
import { getLogger } from '@/server/logger';
import { handleOrderAction } from '@/server/orders/actions-handler';
import { getRedis } from '@/server/redis';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const engine = getEngineDeps();
  return handleOrderAction(request, token, {
    engine,
    redis: getRedis(),
    appBaseUrl: engine.env.APP_BASE_URL,
    logger: getLogger(),
  });
}
