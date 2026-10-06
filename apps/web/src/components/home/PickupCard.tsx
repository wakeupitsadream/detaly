import { PickupCard as PickupPointCard } from '@/components/PickupCard';
import { pickupRoutes } from '@/components/PickupRouteLinks';
import type { Brand } from '@/server/brand';

/**
 * «Точка выдачи» of the home page (anchor #pickup): the shared PickupCard with the address,
 * hours, phone, routes and the partner's colour logo from env. With neither an address nor a
 * phone there is nothing to show yet, so the card is left out rather than drawn empty.
 */
export function PickupCard({
  brand,
  className,
}: {
  brand: Pick<Brand, 'pickup' | 'pickupLinks' | 'pickupLogo' | 'contactPhone'>;
  className?: string;
}) {
  if (!brand.pickup.address && !brand.contactPhone) return null;
  return (
    <PickupPointCard
      id="pickup"
      title="Точка выдачи"
      titleId="pickup-title"
      testId="home-pickup"
      nameTestId="home-pickup-name"
      pickup={brand.pickup}
      phone={brand.contactPhone}
      routes={pickupRoutes(brand)}
      logo={brand.pickupLogo?.color ?? null}
      className={className}
    />
  );
}
