import { formatRub } from '@detaly/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  IconArrowRight,
  IconChevronDown,
  IconClock,
  IconMessage,
  IconPhone,
  IconPin,
  IconRoute,
} from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { MarkerBar } from '@/components/ui/Card';
import { cn } from '@/components/ui/cn';
import { PartTile } from '@/components/ui/PartTile';
import { Price } from '@/components/ui/Price';
import type { InstallPlanView } from '@/server/install/types';
import type { CartReminder } from '@/server/orders/cart-reminder';
import type { OrderItemView } from '@/server/orders/order-view';
import type { StatusTone } from '@/server/orders/status-labels';
import type { TimelineEntry } from '@/server/orders/timeline';

/** Pickup point from env (PICKUP_*): any field may be missing. */
export interface PickupInfo {
  name: string | null;
  address: string | null;
  hours: string | null;
  phone: string | null;
}

/** A route to the pickup point (components/PickupRouteLinks → pickupRoutes). */
export interface PickupRoute {
  label: string;
  href: string;
}

const TONE_CLASS: Record<StatusTone, string> = {
  wait: 'bg-wait-soft text-wait',
  progress: 'bg-info-soft text-info',
  success: 'bg-ok-soft text-ok',
  stopped: 'bg-surface-2 text-ink',
};

/** The status of the order, large: a round chip on the soft fill of its tone, with a dot. */
export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <span
      className={cn(
        'inline-flex min-h-10 max-w-full items-center gap-2 rounded-full px-4 py-1 text-[1.0625rem] leading-snug font-bold',
        TONE_CLASS[tone],
      )}
      data-testid="order-status"
    >
      <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-current" />
      {label}
    </span>
  );
}

/**
 * A card of the order page: white, a `line` border, `rounded-tile`, an optional brand icon and
 * a `text-h3` title.
 */
export function Card({
  title,
  icon,
  children,
  testId,
  aside,
  tight = false,
  attention = false,
  className,
  id,
}: {
  title?: string;
  /** A decision is waiting for the client: a 2 px brand frame. */
  attention?: boolean;
  /** A brand icon left of the title (24-28 px). */
  icon?: ReactNode;
  children: ReactNode;
  testId?: string;
  aside?: ReactNode;
  /** The content (a list with its own padding) starts right under the title. */
  tight?: boolean;
  className?: string;
  /** Anchor of the block (#install, #claim, #notify, #decision): forms redirect back to it. */
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        'min-w-0 scroll-mt-24 rounded-tile bg-bg p-4 md:p-6',
        attention ? 'border-2 border-brand' : 'border border-line',
        className,
      )}
      data-testid={testId}
    >
      {title ? (
        <div className={cn('flex min-w-0 items-center gap-3', tight ? 'mb-1' : 'mb-4')}>
          {icon ? <span className="shrink-0 text-brand">{icon}</span> : null}
          <h2 className="min-w-0 text-h3">{title}</h2>
          {aside ? <div className="ml-auto shrink-0">{aside}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** 'tel:' href from a human-written phone. */
export function phoneHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/**
 * Shown when PICKUP_ADDRESS is not set. Checkout is closed without it (checkout-gate.ts), so an
 * order page only meets it for orders made before; no message is promised that nobody sends.
 */
export const PICKUP_ADDRESS_UNKNOWN = 'Адрес пункта выдачи уточните по телефону магазина.';

/**
 * The code the client names at the pickup point: 40 px, extra bold, spaced digits on a white
 * plate (docs/design-v2.md, PickupCode).
 */
export function PickupCodeBlock({ code }: { code: string }) {
  return (
    <section
      className="min-w-0 rounded-tile border border-line bg-bg px-5 py-4 text-center"
      data-testid="order-pickup-code"
    >
      <h2 className="text-body font-bold">Код выдачи</h2>
      <p className="mt-1 text-[2.5rem] leading-tight font-extrabold tracking-[0.2em] text-ink tabular-nums">
        {code}
      </p>
      <p className="mt-1 text-small font-normal text-muted">Назовите его в пункте выдачи</p>
    </section>
  );
}

/**
 * Where to collect the order (docs/design-v2.md, «Заказ»): a grey panel with the marker bar,
 * the pickup code when there is one, the address with hours and the phone, route buttons and
 * the partner's colour mark (PICKUP_LOGO_SRC) when set.
 */
export function PickupBlock({
  pickup,
  code = null,
  routes = [],
  logoSrc = null,
  className,
}: {
  className?: string;
  pickup: PickupInfo;
  /** The pickup code (from `ready` on). */
  code?: string | null;
  routes?: readonly PickupRoute[];
  logoSrc?: string | null;
}) {
  const empty = !pickup.name && !pickup.address && !pickup.hours && !pickup.phone;
  return (
    <section
      className={cn('relative min-w-0 rounded-panel bg-surface p-4 md:p-6', className)}
      aria-labelledby="order-pickup-title"
      data-testid="order-pickup"
    >
      <MarkerBar className="absolute top-0 left-4 md:left-6" />
      <div className="flex min-w-0 items-start justify-between gap-4 pt-2">
        <h2 id="order-pickup-title" className="text-h2">
          Где забрать
        </h2>
        {logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- a small static mark from env
          <img
            src={logoSrc}
            alt={pickup.name ?? ''}
            width={72}
            height={63}
            className="-mt-1 h-14 w-16 shrink-0 object-contain"
          />
        ) : null}
      </div>
      {code ? (
        <div className="mt-4">
          <PickupCodeBlock code={code} />
        </div>
      ) : null}
      {empty ? (
        <p className="mt-4 text-body text-muted">{PICKUP_ADDRESS_UNKNOWN}</p>
      ) : (
        <address className="mt-4 flex min-w-0 gap-3 not-italic">
          <IconPin size={26} className="mt-0.5 shrink-0 text-brand" />
          <div className="min-w-0 space-y-1">
            {pickup.name ? (
              <p className="text-body font-bold wrap-anywhere">{pickup.name}</p>
            ) : null}
            {pickup.address ? <p className="text-body wrap-anywhere">{pickup.address}</p> : null}
            {pickup.hours ? (
              <p className="flex items-center gap-1.5 text-small font-normal text-muted wrap-anywhere">
                <IconClock size={18} className="shrink-0" />
                {pickup.hours}
              </p>
            ) : null}
            {pickup.phone ? (
              <p>
                <a
                  className="inline-flex min-h-11 items-center gap-1.5 text-body font-semibold whitespace-nowrap text-brand underline underline-offset-4"
                  href={phoneHref(pickup.phone)}
                >
                  <IconPhone size={20} className="shrink-0" />
                  {pickup.phone}
                </a>
              </p>
            ) : null}
          </div>
        </address>
      )}
      {routes.length > 0 ? (
        <div className="mt-4 flex min-w-0 flex-wrap gap-2">
          {routes.map((route) => (
            <a
              key={route.href}
              href={route.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Маршрут: ${route.label} (откроется в новой вкладке)`}
              className={buttonClass({ variant: 'secondary' })}
            >
              <IconRoute size={20} className="text-brand" />
              {route.label}
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ItemRow({ item }: { item: OrderItemView }) {
  return (
    <li
      className={cn(
        'grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-x-3 py-3.5',
        item.inactive && 'opacity-55',
      )}
      data-testid="order-item"
      data-state={item.state}
    >
      <PartTile name={item.name} size="sm" />
      <div className="min-w-0">
        <p className="text-[1.0625rem] leading-snug font-bold wrap-anywhere">
          {item.brand} <span className="tabular-nums">{item.article}</span>
        </p>
        <p className="line-clamp-1 text-small font-normal text-muted wrap-anywhere">{item.name}</p>
        {item.isLocal ? <p className="text-small text-ok">Склад в Оренбурге</p> : null}
        {item.stateLabel ? (
          <p className="mt-1 text-small font-semibold text-info" data-testid="order-item-state">
            {item.stateLabel}
          </p>
        ) : null}
      </div>
      <div className="text-right">
        <p className="text-[1.0625rem] font-bold whitespace-nowrap tabular-nums">
          {formatRub(item.lineTotalKop)}
        </p>
        <p className="text-small font-normal whitespace-nowrap text-muted tabular-nums">
          {item.qty} × {formatRub(item.priceClientKop)}
        </p>
      </div>
    </li>
  );
}

export function ItemsBlock({
  items,
  subtotalKop,
  courierFeeKop,
  totalKop,
}: {
  items: readonly OrderItemView[];
  subtotalKop: number;
  courierFeeKop: number;
  totalKop: number;
}) {
  return (
    <Card
      title="Состав заказа"
      testId="order-items"
      tight
      aside={<span className="text-small text-muted">{items.length} поз.</span>}
    >
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
      <dl className="mt-1 space-y-1.5 border-t border-line-strong pt-4">
        {courierFeeKop > 0 ? (
          <>
            <div className="flex justify-between gap-3 text-small text-muted">
              <dt>Запчасти</dt>
              <dd className="whitespace-nowrap tabular-nums">{formatRub(subtotalKop)}</dd>
            </div>
            <div className="flex justify-between gap-3 text-small text-muted">
              <dt>Доставка</dt>
              <dd className="whitespace-nowrap tabular-nums">{formatRub(courierFeeKop)}</dd>
            </div>
          </>
        ) : null}
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-body font-semibold">Итого</dt>
          <dd>
            <Price data-testid="order-total">{formatRub(totalKop)}</Price>
          </dd>
        </div>
      </dl>
    </Card>
  );
}

/** «История заказа», folded: the events are there for whoever wants them. */
export function TimelineBlock({ entries }: { entries: readonly TimelineEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <details
      className="details-plain group min-w-0 rounded-tile border border-line bg-bg"
      data-testid="order-timeline"
    >
      <summary className="flex min-h-14 items-center gap-3 rounded-tile px-4 hover:bg-surface md:px-6">
        <IconClock size={24} className="shrink-0 text-brand" />
        <span className="min-w-0 flex-1 text-h3">История заказа</span>
        <span className="text-small text-muted tabular-nums">{entries.length}</span>
        <IconChevronDown
          size={22}
          className="shrink-0 text-muted transition-transform duration-150 group-open:rotate-180"
        />
      </summary>
      <ol className="relative mx-4 mt-2 mb-5 space-y-4 border-l-2 border-line pl-5 md:mx-6">
        {entries.map((entry, index) => (
          <li key={entry.id} className="relative flex min-w-0 flex-col">
            <span
              aria-hidden
              className={cn(
                'absolute top-1.5 -left-[27px] size-3 rounded-full border-2 border-bg',
                index === entries.length - 1 ? 'bg-brand' : 'bg-line-strong',
              )}
            />
            <time dateTime={entry.at} className="text-small text-muted tabular-nums">
              {entry.timeText}
            </time>
            <span className="text-body wrap-anywhere">{entry.text}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * The sample order (DEMO_MODE): what a status message looks like in the messenger, instead of
 * binding buttons that do nothing in a demo. Built from the order's own number, date and lift
 * slot, so it never disagrees with the page.
 */
export function MessengerPreview({
  number,
  install,
  hours,
  bare = false,
}: {
  number: string;
  install: InstallPlanView | null;
  hours: string | null;
  /** Inside the notifications card of the demo (phase 1C): no card and title of its own. */
  bare?: boolean;
}) {
  // 'пн 5 окт с 11:00' -> 'пн 5 окт, окно на подъёмнике с 11:00'
  const when = install
    ? `Ждём вас ${install.slotText.replace(' с ', ', окно на подъёмнике с ')}.`
    : hours
      ? `Ждём вас: ${hours}.`
      : 'Ждём вас в пункте выдачи.';
  const body = (
    <>
      <p className="text-small font-normal text-muted">
        {bare
          ? 'Так выглядит сообщение, когда детали приедут:'
          : 'Статусы приходят в MAX или Telegram. Так выглядит сообщение, когда детали приедут:'}
      </p>
      <div className="mt-3 rounded-tile bg-surface p-4" data-testid="messenger-preview">
        <p className="flex items-center gap-2 text-small font-semibold text-muted">
          <IconMessage size={18} className="shrink-0 text-brand" />
          Бот магазина
        </p>
        <div className="mt-3 max-w-md rounded-tile rounded-tl-md bg-bg px-4 py-3 shadow-[0_1px_2px_rgb(17_19_23/0.08)]">
          <p className="text-body">
            Заказ {number}: детали приехали. {when}
          </p>
          <p className="mt-1 text-right text-caption text-muted tabular-nums">09:05</p>
        </div>
      </div>
    </>
  );
  if (bare) return <div className="mt-5 border-t border-line pt-5">{body}</div>;
  return (
    <Card title="Уведомления о статусе" testId="order-messengers">
      {body}
    </Card>
  );
}

export function CartReminderBanner({ reminder }: { reminder: CartReminder }) {
  return (
    <Link
      href={reminder.href}
      className="group flex min-h-14 min-w-0 items-center justify-between gap-3 rounded-tile bg-info-soft px-4 py-3 text-body font-semibold text-ink"
      data-testid="cart-reminder"
    >
      <span className="min-w-0 underline-offset-4 group-hover:underline">{reminder.text}</span>
      <IconArrowRight size={22} className="shrink-0 text-info" />
    </Link>
  );
}
