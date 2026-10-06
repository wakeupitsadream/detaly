/**
 * Photos of the packed parts (docs/phase-1c-implementation.md section 10.4, decision С17): the
 * master photographs the packaging when the parts arrive. Thumbnails load lazily from
 * /api/orders/<token>/photos/<id> (private, no-store); a tap opens the full photo. A photo
 * without a file (the demo order's sample) is not drawn: a grey plate in its place read as a
 * broken picture, so the block appears with the first real photo.
 */
import { IconBox } from '@/components/icons';
import type { OrderPhotoItem } from '@/server/orders/order-services';
import { Card } from './OrderSections';

const KIND_LABEL: Record<OrderPhotoItem['kind'], string> = {
  packaging: 'Упаковка',
  handover: 'Выдача',
};

export function OrderPhotos({ photos }: { photos: OrderPhotoItem[] }) {
  const shown = photos.filter((photo) => photo.url);
  if (shown.length === 0) return null;
  return (
    <Card title="Фото упаковки" icon={<IconBox size={26} />} testId="order-photos">
      <ul className="grid grid-cols-3 gap-2">
        {shown.map((photo, index) => (
          <li key={photo.id} className="min-w-0">
            <a
              href={photo.url ?? undefined}
              className="block aspect-square overflow-hidden rounded-control border border-line bg-surface"
              data-testid="order-photo"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- private, no-store images */}
              <img
                src={photo.url ?? undefined}
                alt={`${KIND_LABEL[photo.kind]}, фото ${index + 1}`}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-small font-normal text-muted">
        Мастер снимает упаковку, когда детали приезжают.
      </p>
    </Card>
  );
}
