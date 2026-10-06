import type { ReactNode } from 'react';
import { IconClock, IconPhone, IconPin } from '@/components/icons';
import { PickupRouteLinks } from '@/components/PickupRouteLinks';
import { InfoCard } from '@/components/ui/Card';
import { cn } from '@/components/ui/cn';
import { telHref, type Brand } from '@/server/brand';

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <dt className="mt-0.5 shrink-0 text-brand">
        <span aria-hidden>{icon}</span>
        <span className="sr-only">{label}</span>
      </dt>
      <dd className="min-w-0 text-body font-medium wrap-anywhere">{children}</dd>
    </div>
  );
}

/**
 * «Точка выдачи» (anchor #pickup): the partner's colour logo (or a pin), the address, hours and
 * phone from env, and the routes in Яндекс Карты / 2ГИС. Later the photo of the place goes
 * where the logo is.
 */
export function PickupCard({
  brand,
  className,
}: {
  brand: Pick<Brand, 'pickup' | 'pickupLinks' | 'pickupLogo' | 'contactPhone'>;
  className?: string;
}) {
  const { pickup } = brand;
  const logo = brand.pickupLogo?.color ?? null;
  return (
    <InfoCard
      id="pickup"
      title="Точка выдачи"
      titleId="pickup-title"
      aria-labelledby="pickup-title"
      data-testid="home-pickup"
      className={cn('scroll-mt-28', className)}
    >
      <div className="grid min-w-0 gap-6 md:grid-cols-2 md:items-center md:gap-8 lg:gap-12">
        <div className="min-w-0">
          {/* The colour logo already names the place; the text name stands in without it. */}
          {pickup.name && !logo ? (
            <p className="text-h3" data-testid="home-pickup-name">
              {pickup.name}
            </p>
          ) : null}
          <dl className={cn('grid min-w-0 gap-3', pickup.name && !logo && 'mt-4')}>
            <Row icon={<IconPin size={24} />} label="Адрес">
              <address className="not-italic">{pickup.address ?? 'Адрес уточняется'}</address>
            </Row>
            {pickup.hours ? (
              <Row icon={<IconClock size={24} />} label="Часы">
                {pickup.hours}
              </Row>
            ) : null}
            {brand.contactPhone ? (
              <Row icon={<IconPhone size={24} />} label="Телефон">
                <a
                  href={telHref(brand.contactPhone)}
                  className="font-bold whitespace-nowrap tabular-nums underline decoration-line-strong underline-offset-4 hover:decoration-brand"
                >
                  {brand.contactPhone}
                </a>
              </Row>
            ) : null}
          </dl>
          <PickupRouteLinks brand={brand} className="mt-6 max-sm:*:w-full" />
        </div>
        {/* Phones: the picture right under the title, as on the reference cards. */}
        <div className="order-first flex h-36 min-w-0 items-center justify-center rounded-tile bg-bg p-4 md:order-none md:h-64">
          {logo ? (
            // A plain img: the partner's logo, a small WebP from public/.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt={pickup.name ? `Логотип: ${pickup.name}` : 'Логотип точки выдачи'}
              width={320}
              height={280}
              loading="lazy"
              decoding="async"
              className="h-full w-auto max-w-full object-contain"
            />
          ) : (
            <IconPin size={72} strokeWidth={1.25} className="text-brand" aria-hidden />
          )}
        </div>
      </div>
    </InfoCard>
  );
}
