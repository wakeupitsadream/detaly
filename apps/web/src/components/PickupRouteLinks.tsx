import type { Brand } from '@/server/brand';
import { IconExternal, IconRoute } from './icons';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';

/**
 * Route links of the pickup point: PICKUP_MAP_URL_YANDEX / PICKUP_MAP_URL_2GIS when set,
 * otherwise a search by the address in each maps service. Plain external anchors.
 */
export function pickupRoutes(brand: Pick<Brand, 'pickup' | 'pickupLinks'>): PickupRoute[] {
  const address = brand.pickup.address;
  const yandex =
    brand.pickupLinks?.yandexMap ??
    (address ? `https://yandex.ru/maps/?text=${encodeURIComponent(address)}` : null);
  const twoGis =
    brand.pickupLinks?.twoGisMap ??
    (address ? `https://2gis.ru/search/${encodeURIComponent(address)}` : null);
  const routes: PickupRoute[] = [];
  if (yandex) routes.push({ label: 'Яндекс Карты', href: yandex });
  if (twoGis) routes.push({ label: '2ГИС', href: twoGis });
  return routes;
}

/** A route to the pickup point: the maps service and its link. */
export interface PickupRoute {
  label: string;
  href: string;
}

/** Two secondary buttons, 48 px, side by side (they wrap on a narrow screen). */
export function RouteLinks({
  routes,
  onDark = false,
  className,
}: {
  routes: readonly PickupRoute[];
  onDark?: boolean;
  className?: string;
}) {
  if (routes.length === 0) return null;
  return (
    <div className={cn('flex min-w-0 flex-wrap gap-2', className)} data-testid="pickup-routes">
      {routes.map((route) => (
        <a
          key={route.href}
          href={route.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Маршрут: ${route.label} (откроется в новой вкладке)`}
          className={cn(buttonClass({ variant: 'secondary', onDark }), 'px-4')}
        >
          <IconRoute size={20} className={onDark ? undefined : 'text-brand'} />
          {route.label}
          <IconExternal size={16} className="hidden opacity-60 sm:block" />
        </a>
      ))}
    </div>
  );
}

/** RouteLinks of the brand's pickup point (pickupRoutes). */
export function PickupRouteLinks({
  brand,
  onDark = false,
  className,
}: {
  brand: Pick<Brand, 'pickup' | 'pickupLinks'>;
  onDark?: boolean;
  className?: string;
}) {
  return <RouteLinks routes={pickupRoutes(brand)} onDark={onDark} className={className} />;
}
