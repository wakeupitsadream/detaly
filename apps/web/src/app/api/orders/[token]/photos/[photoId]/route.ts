// A packaging or handover photo of this order (docs/phase-1c-implementation.md decision С17).
import { getDb } from '@/server/db';
import { demoNotFound } from '@/server/demo/responses';
import { getFileStore } from '@/server/files';
import { getLogger } from '@/server/logger';
import { isDemoMode } from '@/server/mode';
import { handleOrderPhoto } from '@/server/orders/photo-handler';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string; photoId: string }> },
): Promise<Response> {
  // DEMO_MODE: there are no files (the demo order shows a placeholder without an image).
  if (isDemoMode()) return demoNotFound();
  const { token, photoId } = await params;
  return handleOrderPhoto(token, photoId, {
    db: getDb(),
    files: getFileStore(),
    logger: getLogger(),
  });
}
