/**
 * Order photos (docs/phase-1c-implementation.md decision С17): the packaging photo the seller
 * sends with «Приехало» (shown on /o/<token> and attached to the client's «arrived»), handover
 * photos. Return photos belong to a claim (acceptClaimReturn). The files themselves live in the
 * FileStore; rows hold the keys only.
 */
import { and, asc, eq, inArray, orderPhotos, type Executor } from '@detaly/db';
import type { OrderStatus, PhotoKind } from '@detaly/domain';
import { isOrderFileKey, staffActor } from './claims';
import { clock, nudge } from './engine';
import { recordJournalEvent } from './journal';
import { isUuid, loadOrderSnapshot } from './snapshot';
import type { EngineDeps, OrderPhotoView, ServiceResult, StaffRef } from './types';

/** Statuses without a part to photograph. */
const NO_PHOTO_STATUSES: readonly OrderStatus[] = [
  'draft',
  'awaiting_payment',
  'awaiting_confirmation',
  'cancelled',
  'refunded',
];

/**
 * Adds a packaging or handover photo (key order/<order id>/<uuid>.jpg already in the FileStore):
 * order_photos and journal photo_added. The same key twice is one row.
 */
export async function addOrderPhoto(
  deps: EngineDeps,
  input: {
    orderId: string;
    kind: 'packaging' | 'handover';
    fileKey: string;
    staff: StaffRef;
    itemId?: string | null;
  },
): Promise<ServiceResult> {
  const orderId = input.orderId;
  const refuse = (message: string): ServiceResult => ({ ok: false, message, orderId });
  if (!isUuid(orderId)) return refuse('Заказ не найден');
  if (input.kind !== 'packaging' && input.kind !== 'handover')
    return refuse('Неизвестный вид фото');
  if (!isOrderFileKey(input.fileKey, orderId, ['order'])) return refuse('Фото не сохранилось');
  const itemId = input.itemId ?? null;
  const result = await deps.db.transaction(async (tx): Promise<ServiceResult> => {
    const snapshot = await loadOrderSnapshot(tx, orderId, { lock: true });
    if (snapshot === null) return refuse('Заказ не найден');
    if (NO_PHOTO_STATUSES.includes(snapshot.order.status)) {
      return refuse('Фото к заказу в этом статусе не добавляется');
    }
    if (itemId !== null && !snapshot.items.some((item) => item.id === itemId)) {
      return refuse('Позиция не найдена');
    }
    const [existing] = await tx
      .select({ id: orderPhotos.id })
      .from(orderPhotos)
      .where(and(eq(orderPhotos.orderId, orderId), eq(orderPhotos.s3Key, input.fileKey)));
    if (existing) return { ok: true, message: 'Фото уже сохранено', orderId, photoId: existing.id };
    const at = clock(deps);
    const [photo] = await tx
      .insert(orderPhotos)
      .values({
        orderId,
        kind: input.kind,
        s3Key: input.fileKey,
        byStaffId: isUuid(input.staff.id) ? input.staff.id : null,
        orderItemId: itemId,
        createdAt: at,
      })
      .returning({ id: orderPhotos.id });
    const photoId = (photo as { id: string }).id;
    await recordJournalEvent(tx, {
      orderId,
      type: 'photo_added',
      actor: staffActor(input.staff),
      payload: {
        photoId,
        kind: input.kind,
        via: input.staff.via,
        ...(itemId !== null ? { itemId } : {}),
      },
      at,
    });
    return { ok: true, message: 'Фото сохранено', orderId, photoId };
  });
  if (result.ok) nudge(deps);
  return result;
}

/** Photos of an order of the given kinds, oldest first (keys for the FileStore). */
export async function loadOrderPhotos(
  db: Executor,
  orderId: string,
  kinds: readonly PhotoKind[],
): Promise<OrderPhotoView[]> {
  if (!isUuid(orderId) || kinds.length === 0) return [];
  const rows = await db
    .select()
    .from(orderPhotos)
    .where(and(eq(orderPhotos.orderId, orderId), inArray(orderPhotos.kind, [...kinds])))
    .orderBy(asc(orderPhotos.createdAt), asc(orderPhotos.id));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    key: row.s3Key,
    claimId: row.claimId,
    orderItemId: row.orderItemId,
    createdAt: row.createdAt,
  }));
}
