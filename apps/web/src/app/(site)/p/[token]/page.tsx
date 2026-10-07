import { isProposalToken, loadProposal } from '@detaly/vin';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { ProposalSheet, type ProposalMode } from '@/components/vin/ProposalSheet';
import { getBrand } from '@/server/brand';
import { getDb } from '@/server/db';
import { buildDemoProposal, DEMO_PROPOSAL_TOKEN } from '@/server/demo/proposal-fixture';
import { createDemoSupplier } from '@/server/demo/supplier';
import { serverEnv } from '@/server/env';
import { errorInfo, PageDataError } from '@/server/errors';
import { singleton } from '@/server/globals';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { getSupplier, type Supplier } from '@/server/supplier';
import { proposalPageView, type ProposalPageView } from '@/server/vin/proposal-page';

// Reads the database (the proposal) and env on every request; the token is a bearer secret.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Подборка мастера',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

type Params = Promise<{ token: string }>;

/**
 * The sample's supplier: in DEMO_MODE the demo one; otherwise the bundled fixtures behind an
 * in-memory limiter (the sample never spends the live Rossko quota or touches Redis).
 */
function sampleSupplier(): Supplier {
  if (isDemoMode()) return getSupplier();
  return singleton('proposal-sample-supplier', () => createDemoSupplier({ env: serverEnv() }));
}

async function samplePage(): Promise<ProposalPageView> {
  const supplier = sampleSupplier();
  const loadSettings = () => supplier.settings.get();
  const demo = await buildDemoProposal({ rossko: supplier.rossko, loadSettings });
  return proposalPageView(
    { comment: demo.comment, lines: demo.lines, expiresAt: demo.expiresAt, expired: false },
    { rossko: supplier.rossko, loadSettings },
  );
}

/**
 * /p/<token>: the master's proposal for a VIN request (phase 1C, decision С14). noindex and
 * Referrer-Policy no-referrer (here and in src/proxy.ts). /p/demo is the sample: in DEMO_MODE
 * its button fills the demo cart, elsewhere it is read-only.
 */
export default async function ProposalPage({ params }: { params: Params }) {
  const { token } = await params;
  const brand = getBrand();
  let view: ProposalPageView;
  let mode: ProposalMode;
  if (token === DEMO_PROPOSAL_TOKEN) {
    view = await samplePage();
    mode = isDemoMode()
      ? { kind: 'live', action: `/api/proposals/${DEMO_PROPOSAL_TOKEN}/take` }
      : { kind: 'sample' };
  } else {
    // DEMO_MODE has no proposals but the sample (src/proxy.ts answers 404 first).
    if (isDemoMode() || !isProposalToken(token)) notFound();
    let loaded: { view: ProposalPageView; expired: boolean } | null;
    try {
      const proposal = await loadProposal(getDb(), token, new Date());
      const supplier = getSupplier();
      loaded =
        proposal === null
          ? null
          : {
              expired: proposal.expired,
              view: await proposalPageView(
                {
                  comment: proposal.comment,
                  lines: proposal.lines,
                  expiresAt: proposal.expiresAt,
                  expired: proposal.expired,
                },
                { rossko: supplier.rossko, loadSettings: () => supplier.settings.get() },
              ),
            };
    } catch (error) {
      // Names and SQLSTATE only: a driver message carries the token from the URL.
      getLogger().error(errorInfo(error), 'proposal page: data unavailable');
      throw new PageDataError('proposal page: data unavailable');
    }
    if (loaded === null) notFound();
    view = loaded.view;
    mode = loaded.expired
      ? { kind: 'expired' }
      : { kind: 'live', action: `/api/proposals/${token}/take` };
  }

  return (
    <InnerPage>
      <PageBand
        tone="light"
        eyebrow="Подбор по VIN"
        title="Подборка мастера"
        lead="Мастер подобрал под вашу машину."
        titleTestId="proposal-title"
      />
      <PageBody>
        <ProposalSheet view={view} mode={mode} contactPhone={brand.contactPhone} />
      </PageBody>
    </InnerPage>
  );
}
