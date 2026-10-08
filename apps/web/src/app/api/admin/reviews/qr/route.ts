// «Скачать QR (SVG)» of /admin/reviews (step 3, docs/reviews.md): the QR of APP_BASE_URL/review
// as a file for the paper return memo. Basic auth in src/proxy.ts and again here.
import { ADMIN_RESPONSE_HEADERS } from '@/server/admin-auth';
import { adminAuthFailure } from '@/server/admin/http';
import { qrSvg } from '@/server/admin/qr';
import { reviewPageUrl } from '@/server/admin/reviews';
import { demoNotFound } from '@/server/demo/responses';
import { serverEnv } from '@/server/env';
import { isDemoMode } from '@/server/mode';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (isDemoMode()) return demoNotFound();
  const env = serverEnv();
  const denied = adminAuthFailure(request, env);
  if (denied) return denied;
  return new Response(await qrSvg(reviewPageUrl(env)), {
    status: 200,
    headers: {
      ...ADMIN_RESPONSE_HEADERS,
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="review-qr.svg"',
    },
  });
}
