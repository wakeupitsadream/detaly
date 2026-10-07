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

/**
 * How the route links look: `buttons` — secondary 48 px buttons side by side (they wrap on a
 * narrow screen); `grid` — the same buttons in two equal columns from sm and one under the
 * other on phones (the pickup cards: no ragged right edge); `inline` — quiet 15 px text links
 * with the external-link mark (the footer: a reference, not a second set of buttons).
 */
export type RouteLinksVariant = 'buttons' | 'grid' | 'inline';

export function RouteLinks({
  routes,
  onDark = false,
  variant = 'buttons',
  className,
}: {
  routes: readonly PickupRoute[];
  onDark?: boolean;
  variant?: RouteLinksVariant;
  className?: string;
}) {
  if (routes.length === 0) return null;
  if (variant === 'inline') {
    return (
      <p
        className={cn('flex min-w-0 flex-wrap items-center gap-x-1 text-small', className)}
        data-testid="pickup-routes"
      >
        {routes.map((route, index) => (
          <span key={route.href} className="inline-flex items-center gap-x-1">
            {index > 0 ? (
              <span aria-hidden className="text-faint">
                ·
              </span>
            ) : null}
            <a
              href={route.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Маршрут: ${route.label} (откроется в новой вкладке)`}
              className="inline-flex min-h-11 items-center gap-1 px-0.5 font-medium text-muted underline decoration-line-strong underline-offset-4 hover:text-ink hover:decoration-ink"
            >
              {route.label}
              <IconExternal size={16} className="shrink-0" />
            </a>
          </span>
        ))}
      </p>
    );
  }
  const grid = variant === 'grid';
  return (
    <div
      className={cn(
        'min-w-0 gap-2',
        // Full width one under the other on phones, two equal columns from sm.
        grid ? 'grid sm:grid-cols-2' : 'flex flex-wrap',
        className,
      )}
      data-testid="pickup-routes"
    >
      {routes.map((route) => (
        <a
          key={route.href}
          href={route.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Маршрут: ${route.label} (откроется в новой вкладке)`}
          className={cn(
            buttonClass({ variant: 'secondary', onDark }),
            // Two columns of a 384 px card are ~164 px: a tighter padding and no external mark
            // (the label says «откроется в новой вкладке») keep «Яндекс Карты» on one line.
            grid ? 'w-full gap-1.5 px-2 whitespace-nowrap' : 'px-4',
          )}
        >
          <IconRoute size={20} className={cn('shrink-0', !onDark && 'text-brand')} />
          {route.label}
          {grid ? null : <IconExternal size={16} className="hidden shrink-0 opacity-60 sm:block" />}
        </a>
      ))}
    </div>
  );
}

/** RouteLinks of the brand's pickup point (pickupRoutes). */
export function PickupRouteLinks({
  brand,
  onDark = false,
  variant,
  className,
}: {
  brand: Pick<Brand, 'pickup' | 'pickupLinks'>;
  onDark?: boolean;
  variant?: RouteLinksVariant;
  className?: string;
}) {
  return (
    <RouteLinks
      routes={pickupRoutes(brand)}
      onDark={onDark}
      variant={variant}
      className={className}
    />
  );
}
