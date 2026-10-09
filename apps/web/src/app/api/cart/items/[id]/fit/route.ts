// POST /api/cart/items/<id>/fit: «Заменить» / «Оставить как есть» on the master's analog (step 4,
// server/fit-checks/line-actions.ts). Origin is checked in the handler; the `cart` rate limit is
// applied in src/proxy.ts.
import { getFitLineActionDeps } from '@/server/fit-checks';
import { handleFitLineAction } from '@/server/fit-checks/line-actions';
import { isDemoMode } from '@/server/mode';
import { jsonResponse, messagePage, wantsJson } from '@/server/vin/http';

export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { id } = await params;
  if (isDemoMode()) {
    // The demo has no master and so no analogs to take.
    return wantsJson(request)
      ? jsonResponse(404, { error: 'not_found' })
      : messagePage(404, 'Не найдено', 'В демо мастер не предлагает аналоги', {
          href: '/cart',
          label: 'Вернуться в корзину',
        });
  }
  return handleFitLineAction(request, id, getFitLineActionDeps());
}
