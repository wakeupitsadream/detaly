// POST /api/cart/items: add an offer (form -> 303, JSON -> 200 {count, totalKop}).
// Origin is checked in the handler; rate limits are applied in src/proxy.ts.
import { getCartHandlerDeps, getDemoCartRequestDeps } from '@/server/cart';
import { handleAddItem } from '@/server/cart/http';
import { handleDemoCartRequest } from '@/server/demo/cart-http';
import { isDemoMode } from '@/server/mode';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  if (isDemoMode()) {
    // DEMO_MODE: the same handler over the signed demo_cart cookie (server/demo/cart-http.ts).
    return handleDemoCartRequest(request, getDemoCartRequestDeps(), (deps) =>
      handleAddItem(request, deps),
    );
  }
  return handleAddItem(request, getCartHandlerDeps());
}
