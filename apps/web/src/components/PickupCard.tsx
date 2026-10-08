import type { ReactNode } from 'react';
import { IconClock, IconPhone, IconPin } from './icons';
import { RouteLinks, type PickupRoute } from './PickupRouteLinks';
import { MarkerBar } from './ui/Card';
import { cn } from './ui/cn';

/** The pickup point from env (PICKUP_*): any field may be missing. */
export interface PickupPoint {
  name: string | null;
  address: string | null;
  hours: string | null;
  phone: string | null;
}

/** Instead of the address while PICKUP_ADDRESS is not set: no «уточняется» on every page. */
export const PICKUP_ADDRESS_PENDING = 'Адрес появится к запуску';

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

function Row({
  icon,
  label,
  center = false,
  children,
}: {
  icon: ReactNode;
  label: string;
  /** Centre the icon on a 44 px link (the phone) instead of the first text line. */
  center?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 gap-3', center ? 'items-center' : 'items-start')}>
      <dt className={cn('shrink-0 text-brand', !center && 'mt-0.5')}>
        <span aria-hidden>{icon}</span>
        <span className="sr-only">{label}</span>
      </dt>
      <dd className="min-w-0 text-body wrap-anywhere">{children}</dd>
    </div>
  );
}

/**
 * The pickup point, one design on every page (docs/design-v2.md: «Пункт выдачи» on the home
 * page and /about, «Куда принести» on /returns, «Где забрать» on the order page): a grey panel
 * with the marker, the title, the point's name in plain text, the address, hours and phone with
 * brand icons and the route buttons. The service appears here only as the pickup point
 * (decision of 08.10): its name is a line of text, not a logo.
 *
 * `wide` (home, /about, /returns): the name as an ordinary line over the address. A colour logo
 * (PICKUP_LOGO_SRC; not set in production, the partner's marks are not shown) would stand on a
 * white plate beside the lines from md, above them on phones; without it there is no plate.
 * `stack` (the order page's side column): an h3 title without the marker, never a logo, the
 * name in bold over the address.
 * `children` go right under the title (the pickup code of an order); `extra` after the lines.
 */
export function PickupCard({
  title,
  titleId,
  pickup,
  phone = pickup.phone,
  routes = [],
  logo = null,
  layout = 'wide',
  fallback = PICKUP_ADDRESS_PENDING,
  children,
  extra,
  id,
  testId,
  nameTestId,
  className,
}: {
  title: string;
  titleId: string;
  pickup: PickupPoint;
  /** The phone to call (Brand.contactPhone); the point's own phone by default. */
  phone?: string | null;
  routes?: readonly PickupRoute[];
  logo?: string | null;
  layout?: 'wide' | 'stack';
  /** What stands in the address line without PICKUP_ADDRESS. */
  fallback?: string;
  children?: ReactNode;
  extra?: ReactNode;
  id?: string;
  testId?: string;
  nameTestId?: string;
  className?: string;
}) {
  const wide = layout === 'wide';
  const logoAlt = pickup.name ? `Логотип: ${pickup.name}` : 'Логотип пункта выдачи';
  const lines = (
    <div className="min-w-0">
      {pickup.name ? (
        <p
          className={cn('wrap-anywhere', wide ? 'mb-4 text-body' : 'mb-3 text-body font-bold')}
          data-testid={nameTestId}
        >
          {pickup.name}
        </p>
      ) : null}
      <address className="not-italic">
        <dl className="grid min-w-0 gap-3">
          <Row icon={<IconPin size={24} />} label="Адрес">
            {pickup.address ? (
              <span className="font-semibold">{pickup.address}</span>
            ) : (
              <span className="text-muted">{fallback}</span>
            )}
          </Row>
          {pickup.hours ? (
            <Row icon={<IconClock size={24} />} label="Часы">
              {pickup.hours}
            </Row>
          ) : null}
          {phone ? (
            <Row icon={<IconPhone size={24} />} label="Телефон" center>
              <a
                href={telHref(phone)}
                className="inline-flex min-h-11 items-center font-bold whitespace-nowrap tabular-nums underline decoration-line-strong underline-offset-4 hover:decoration-brand"
              >
                {phone}
              </a>
            </Row>
          ) : null}
        </dl>
      </address>
      {extra ? <div className="mt-4 min-w-0">{extra}</div> : null}
      {/* Two equal columns everywhere (a 384 px column fits both): one layout per card. */}
      <RouteLinks routes={routes} variant="grid" className="mt-5 sm:max-w-md" />
    </div>
  );
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-testid={testId}
      className={cn(
        'min-w-0 scroll-mt-28 text-ink',
        // The page-wide card is a grey panel; in the order's column it is a white card like
        // its neighbours (the same frame, padding and h3 heading).
        wide
          ? 'rounded-panel bg-surface p-6 md:p-8'
          : 'rounded-tile border border-line bg-bg p-4 md:p-6',
        className,
      )}
    >
      {/* The marker and the large title only on the page-wide card: in the order's side
          column the card is one of several and takes the same h3 heading as its neighbours. */}
      {wide ? <MarkerBar className="mb-4 md:mb-5" /> : null}
      {wide ? (
        <h2 id={titleId} className="min-w-0 text-h2">
          {title}
        </h2>
      ) : (
        <h2 id={titleId} className="flex min-w-0 items-center gap-3 text-h3">
          <IconPin size={24} className="shrink-0 text-brand" />
          <span className="min-w-0">{title}</span>
        </h2>
      )}
      {children ? <div className="mt-4 min-w-0">{children}</div> : null}
      {logo && wide ? (
        <div className="mt-5 grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_15rem] md:items-center md:gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
          {lines}
          <div className="flex h-32 min-w-0 items-center justify-center rounded-tile bg-bg p-4 max-md:order-first md:h-56">
            {/* eslint-disable-next-line @next/next/no-img-element -- a small WebP from public/ */}
            <img
              src={logo}
              alt={logoAlt}
              width={320}
              height={280}
              loading="lazy"
              decoding="async"
              className="h-full w-auto max-w-full object-contain"
            />
          </div>
        </div>
      ) : (
        <div className="mt-5 min-w-0">{lines}</div>
      )}
    </section>
  );
}
