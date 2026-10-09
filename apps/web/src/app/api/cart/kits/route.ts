// POST /api/cart/kits: «Весь набор в корзину» (step 5, docs/kits.md; server/kits/add-handler.ts).
// Origin is checked in the handler; the cart's rate limit is applied in src/proxy.ts.
import { getCartHandlerDeps, getDemoCartRequestDeps } from '@/server/cart';
import { handleDemoCartRequest } from '@/server/demo/cart-http';
import { kitAddDeps } from '@/server/kits';
import { handleKitAdd } from '@/server/kits/add-handler';
import { isDemoMode } from '@/server/mode';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  if (isDemoMode()) {
    // DEMO_MODE: the same handler over the signed demo_cart cookie and the sample kits.
    return handleDemoCartRequest(request, getDemoCartRequestDeps(), (deps) =>
      handleKitAdd(request, kitAddDeps(deps.service, deps.env)),
    );
  }
  const deps = getCartHandlerDeps();
  return handleKitAdd(request, kitAddDeps(deps.service, deps.env));
}
