// POST /api/fit-checks: «Отправить мастеру» of the fit check form in the cart (step 4,
// server/fit-checks/submit-handler.ts). Rate limit `fit_check` (20 a day per client bucket) and
// the DEMO_MODE redirect are applied in src/proxy.ts; the per-cart limit in the handler.
import { getFitSubmitDeps } from '@/server/fit-checks';
import { demoFitLocation } from '@/server/fit-checks/paths';
import { handleFitSubmit } from '@/server/fit-checks/submit-handler';
import { isDemoMode } from '@/server/mode';
import { seeOther } from '@/server/vin/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // DEMO_MODE: the body (the VIN) is never read; the proxy answers the same first.
  if (isDemoMode()) return seeOther(demoFitLocation(new URL(request.url).searchParams));
  return handleFitSubmit(request, getFitSubmitDeps());
}
