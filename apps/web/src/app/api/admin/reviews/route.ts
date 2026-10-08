// «Сохранить» of the rating snapshot on /admin/reviews (step 3, server/admin/reviews-handler.ts):
// Basic auth in src/proxy.ts and again in the handler.
import { handleAdminReviewsAction } from '@/server/admin/reviews-handler';
import { getDb } from '@/server/db';
import { demoNotFound } from '@/server/demo/responses';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { getRatingReader } from '@/server/reviews/rating';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (isDemoMode()) return demoNotFound();
  return handleAdminReviewsAction(request, {
    db: getDb(),
    env: serverEnv(),
    invalidateRating: () => getRatingReader()?.invalidate(),
    logger: getLogger(),
  });
}
