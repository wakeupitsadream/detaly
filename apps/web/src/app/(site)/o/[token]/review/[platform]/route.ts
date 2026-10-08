// The review buttons of an order (step 3, docs/reviews.md): the first open per platform is
// journaled, then 302 to REVIEW_URL_<platform> (server/reviews/redirect.ts). DEMO_MODE: /o/demo
// redirects without journaling.
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { handleReviewRedirect } from '@/server/reviews/redirect';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ token: string; platform: string }> };

async function redirectToReview(request: Request, { params }: Context): Promise<Response> {
  return handleReviewRedirect(request, await params, {
    env: serverEnv(),
    db: isDemoMode() ? null : getDb(),
    logger: getLogger(),
  });
}

export async function GET(request: Request, context: Context): Promise<Response> {
  return redirectToReview(request, context);
}

/** The same answer without journaling (link checkers): countsAsOpen is false for HEAD. */
export async function HEAD(request: Request, context: Context): Promise<Response> {
  return redirectToReview(request, context);
}
