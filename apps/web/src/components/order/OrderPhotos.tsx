/**
 * Photos of the packed parts (docs/phase-1c-implementation.md section 10.4, decision С17): the
 * master photographs the packaging when the parts arrive. Thumbnails load lazily from
 * /api/orders/<token>/photos/<id> (private, no-store); a tap opens the full photo. The demo
 * order shows a placeholder plate: it has no file at all.
 */
import { Badge } from '@/components/ui/Badge';
import { PartTile } from '@/components/ui/PartTile';
import type { OrderPhotoItem } from '@/server/orders/order-services';
import { Card } from './OrderSections';

const KIND_LABEL: Record<OrderPhotoItem['kind'], string> = {
  packaging: 'Упаковка',
  handover: 'Выдача',
};

export function OrderPhotos({
  photos,
  demo = false,
}: {
  photos: OrderPhotoItem[];
  demo?: boolean;
}) {
  if (photos.length === 0) return null;
  return (
    <Card title="Фото упаковки" testId="order-photos">
      <ul className="grid grid-cols-3 gap-2">
        {photos.map((photo, index) => (
          <li key={photo.id} className="min-w-0">
            {photo.url ? (
              <a
                href={photo.url}
                className="block aspect-square overflow-hidden rounded border border-line-strong bg-paper-2"
                data-testid="order-photo"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- private, no-store images */}
                <img
                  src={photo.url}
                  alt={`${KIND_LABEL[photo.kind]}, фото ${index + 1}`}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </a>
            ) : (
              <div className="grid aspect-square place-items-center" data-testid="order-photo-stub">
                <PartTile name="Фильтр" className="h-full w-full" />
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted">
        Мастер фотографирует упаковку, когда детали приезжают в пункт выдачи.
      </p>
      {demo ? (
        <Badge tone="demo" className="mt-3">
          демо: вместо фото — заглушка
        </Badge>
      ) : null}
    </Card>
  );
}
