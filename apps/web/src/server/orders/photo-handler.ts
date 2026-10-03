/**
 * GET /api/orders/<token>/photos/<photoId> (docs/phase-1c-implementation.md section 10.4,
 * decision С17): a packaging or handover photo of this very order, by the order page token.
 * Return photos and the client's claim photos are never served here (the admin shows them
 * behind Basic auth). Everything else is the same 404: an unknown token, a photo of another
 * order, another kind, a missing file. `Cache-Control: private, no-store`, never indexed.
 */
import type { Logger } from '@detaly/config';
import type { Executor } from '@detaly/db';
import type { FileStore } from '@detaly/files';
import { isUuid, loadOrderPhotos } from '@detaly/orders';
import { errorInfo } from '../errors';
import { isOrderToken } from './access';

const PHOTO_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

export interface PhotoHandlerDeps {
  db: Executor;
  files: FileStore;
  logger?: Pick<Logger, 'warn' | 'error'>;
}

function notFound(): Response {
  return Response.json({ error: 'not_found' }, { status: 404, headers: PHOTO_HEADERS });
}

export async function handleOrderPhoto(
  token: string,
  photoId: string,
  deps: PhotoHandlerDeps,
): Promise<Response> {
  if (!isOrderToken(token) || !isUuid(photoId)) return notFound();
  try {
    const order = await deps.db.query.orders.findFirst({
      where: (t, ops) => ops.eq(t.accessToken, token),
      columns: { id: true },
    });
    if (!order) return notFound();
    const photos = await loadOrderPhotos(deps.db, order.id, ['packaging', 'handover']);
    const photo = photos.find((p) => p.id === photoId.toLowerCase());
    if (!photo) return notFound();
    const file = await deps.files.get(photo.key);
    if (!file) return notFound();
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        ...PHOTO_HEADERS,
        'Content-Type': 'image/jpeg',
        'Content-Length': String(file.bytes.byteLength),
      },
    });
  } catch (error) {
    // Names only: neither the token nor the file key reaches the log.
    deps.logger?.error(errorInfo(error), 'order: photo unavailable');
    return Response.json(
      { error: 'unavailable' },
      { status: 503, headers: { ...PHOTO_HEADERS, 'Retry-After': '60' } },
    );
  }
}
