import { PickupCard as PickupPointCard } from '@/components/PickupCard';
import { pickupRoutes } from '@/components/PickupRouteLinks';
import type { Brand } from '@/server/brand';

/**
 * «Пункт выдачи» of the home page (anchor #pickup): the shared PickupCard with the point's name in
 * plain text, the address, hours, phone and routes (decision of 08.10: the service is only the
 * pickup point; its logo from env is not set in production). With neither an address nor a
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
      title="Пункт выдачи"
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
