// «Оплатить N ₽» on /o/<token>: the payment is created lazily on the client's click (decision
// Б5) and the browser is sent to YooKassa's confirmation page. The IP rate limit belongs to
// src/proxy.ts.
import { getEngineDeps } from '@/server/engine';
import { getLogger } from '@/server/logger';
import { handlePayRequest } from '@/server/payments/pay-handler';
import { getPayments } from '@/server/payments/provider';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const engine = getEngineDeps();
  return handlePayRequest(request, token, {
    engine,
    payments: getPayments()?.payments ?? null,
    appBaseUrl: engine.env.APP_BASE_URL,
    logger: getLogger(),
  });
}
