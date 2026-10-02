// POST /api/checkout: creates an order from the cart (server/checkout/checkout-service.ts).
// The per-IP limit (10 per hour) is applied in src/proxy.ts before this handler runs.
import { handleCheckoutRequest } from '@/server/checkout/handler';
import { getCheckoutService } from '@/server/checkout/service';
import { demoCheckoutForbidden } from '@/server/demo/responses';
import { isDemoMode } from '@/server/mode';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  // DEMO_MODE: no orders and no personal data (the body is not even read).
  if (isDemoMode()) return Promise.resolve(demoCheckoutForbidden());
  return handleCheckoutRequest(request, getCheckoutService());
}
