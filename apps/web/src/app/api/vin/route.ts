// POST /api/vin: the VIN request form (phase 1C, server/vin/submit-handler.ts). Rate limit
// `vin` (5 per hour, 20 per day) and the DEMO_MODE redirect are applied in src/proxy.ts.
import { seeOther } from '@/server/vin/http';
import { getVinSubmitDeps } from '@/server/vin';
import { handleVinSubmit } from '@/server/vin/submit-handler';
import { isDemoMode } from '@/server/mode';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // DEMO_MODE (decision С21): nothing is read or written; the proxy answers the same first.
  if (isDemoMode()) return seeOther('/vin/sent?demo=1');
  return handleVinSubmit(request, getVinSubmitDeps());
}
