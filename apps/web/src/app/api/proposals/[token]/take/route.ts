// POST /api/proposals/<token>/take: «Оформить и оплатить» on /p/<token> (phase 1C,
// server/vin/take-handler.ts). Rate limit `proposal` (30 per hour) in src/proxy.ts.
import { buildDemoProposal, DEMO_PROPOSAL_TOKEN } from '@/server/demo/proposal-fixture';
import { demoNotFound } from '@/server/demo/responses';
import { serverEnv } from '@/server/env';
import { isDemoMode } from '@/server/mode';
import { getSupplier } from '@/server/supplier';
import { getProposalTakeDeps } from '@/server/vin';
import { handleDemoProposalTake, handleProposalTake } from '@/server/vin/take-handler';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (isDemoMode()) {
    // DEMO_MODE: only the sample proposal exists (decision С21); the proxy refuses the rest.
    if (token !== DEMO_PROPOSAL_TOKEN) return demoNotFound();
    const supplier = getSupplier();
    return handleDemoProposalTake(request, {
      env: serverEnv(),
      picks: async () =>
        (
          await buildDemoProposal({
            rossko: supplier.rossko,
            loadSettings: () => supplier.settings.get(),
          })
        ).picks,
    });
  }
  // Outside the demo /p/demo is a read-only sample: nothing to take.
  if (token === DEMO_PROPOSAL_TOKEN) return demoNotFound();
  return handleProposalTake(request, token, getProposalTakeDeps());
}
