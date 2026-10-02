// /api/cart/items/<id>: PATCH (qty), DELETE, or POST with _method=patch|delete from forms.
// Origin is checked in the handler; rate limits are applied in src/proxy.ts.
import { getCartHandlerDeps } from '@/server/cart';
import { handleLineRequest } from '@/server/cart/http';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

async function handle(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  return handleLineRequest(request, id, getCartHandlerDeps());
}

export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
