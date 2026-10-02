// POST /api/checkout: creates an order from the cart (server/checkout/checkout-service.ts).
// The per-IP limit (10 per hour) is applied in src/proxy.ts before this handler runs.
import { handleCheckoutRequest } from '@/server/checkout/handler';
import { getCheckoutService } from '@/server/checkout/service';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleCheckoutRequest(request, getCheckoutService());
}
