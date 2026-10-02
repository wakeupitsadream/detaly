import type { Brand } from '@/server/brand';
import { IconExternal, IconRoute } from './icons';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';

/**
 * Route links of the pickup point: PICKUP_MAP_URL_YANDEX / PICKUP_MAP_URL_2GIS when set,
 * otherwise a search by the address in each maps service. Plain external anchors.
 */
export function pickupRoutes(brand: Pick<Brand, 'pickup' | 'pickupLinks'>): {
  label: string;
  href: string;
}[] {
  const address = brand.pickup.address;
  const yandex =
    brand.pickupLinks?.yandexMap ??
    (address ? `https://yandex.ru/maps/?text=${encodeURIComponent(address)}` : null);
  const twoGis =
    brand.pickupLinks?.twoGisMap ??
    (address ? `https://2gis.ru/search/${encodeURIComponent(address)}` : null);
  const routes: { label: string; href: string }[] = [];
  if (yandex) routes.push({ label: 'Маршрут в Яндекс Картах', href: yandex });
  if (twoGis) routes.push({ label: '2ГИС', href: twoGis });
  return routes;
}

export function PickupRouteLinks({
  brand,
  onDark = false,
  className,
}: {
  brand: Pick<Brand, 'pickup' | 'pickupLinks'>;
  onDark?: boolean;
  className?: string;
}) {
  const routes = pickupRoutes(brand);
  if (routes.length === 0) return null;
  return (
    <div className={cn('flex min-w-0 flex-wrap gap-2', className)} data-testid="pickup-routes">
      {routes.map((route, index) => (
        <a
          key={route.href}
          href={route.href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonClass({ variant: 'secondary', onDark }), 'min-h-10 px-4 text-sm')}
        >
          {index === 0 ? <IconRoute size={17} /> : null}
          {route.label}
          <IconExternal size={14} className="opacity-60" />
        </a>
      ))}
    </div>
  );
}
