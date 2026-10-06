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

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <dt className="mt-0.5 shrink-0 text-brand">
        <span aria-hidden>{icon}</span>
        <span className="sr-only">{label}</span>
      </dt>
      <dd className="min-w-0 text-body wrap-anywhere">{children}</dd>
    </div>
  );
}

/**
 * The pickup point, one design on every page (docs/design-v2.md: «Точка выдачи» on the home
 * page and /about, «Куда принести» on /returns, «Где забрать» on the order page): a grey panel
 * with the marker, the title, the address, hours and phone with brand icons, the route buttons
 * and the partner's colour logo (PICKUP_LOGO_SRC).
 *
 * `wide` (home, /about, /returns): the logo on a white plate beside the lines from md, above
 * them on phones; without a logo there is no empty plate, the point is named in text instead.
 * `stack` (the order page's side column): the logo small at the title, the name in the lines.
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
  const showName = Boolean(pickup.name) && (!logo || !wide);
  const logoAlt = pickup.name ? `Логотип: ${pickup.name}` : 'Логотип точки выдачи';
  const lines = (
    <div className="min-w-0">
      {showName ? (
        <p
          className={cn('wrap-anywhere', wide ? 'mb-4 text-h3' : 'mb-3 text-body font-bold')}
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
            <Row icon={<IconPhone size={24} />} label="Телефон">
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
      <RouteLinks routes={routes} className="mt-5 max-sm:*:w-full" />
    </div>
  );
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-testid={testId}
      className={cn(
        'min-w-0 scroll-mt-28 rounded-panel bg-surface text-ink',
        wide ? 'p-6 md:p-8' : 'p-5 md:p-6',
        className,
      )}
    >
      <MarkerBar className="mb-4 md:mb-5" />
      <div className="flex min-w-0 items-center justify-between gap-4">
        <h2 id={titleId} className="min-w-0 text-h2">
          {title}
        </h2>
        {logo && !wide ? (
          // A plain img: the partner's small WebP from public/, no optimizer needed.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo}
            alt={logoAlt}
            width={72}
            height={63}
            decoding="async"
            className="h-14 w-16 shrink-0 object-contain"
          />
        ) : null}
      </div>
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
