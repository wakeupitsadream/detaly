// /api/cart/items/<id>: PATCH (qty), DELETE, or POST with _method=patch|delete from forms.
// Origin is checked in the handler; rate limits are applied in src/proxy.ts.
import { getCartHandlerDeps, getDemoCartRequestDeps } from '@/server/cart';
import { handleLineRequest } from '@/server/cart/http';
import { handleDemoCartRequest } from '@/server/demo/cart-http';
import { isDemoMode } from '@/server/mode';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

async function handle(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  if (isDemoMode()) {
    // DEMO_MODE: the same handler over the signed demo_cart cookie (server/demo/cart-http.ts).
    return handleDemoCartRequest(request, getDemoCartRequestDeps(), (deps) =>
      handleLineRequest(request, id, deps),
    );
  }
  return handleLineRequest(request, id, getCartHandlerDeps());
}

export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
