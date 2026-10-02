// POST /api/cart/items: add an offer (form -> 303, JSON -> 200 {count, totalKop}).
// Origin is checked in the handler; rate limits are applied in src/proxy.ts.
import { getCartHandlerDeps } from '@/server/cart';
import { handleAddItem } from '@/server/cart/http';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return handleAddItem(request, getCartHandlerDeps());
}
