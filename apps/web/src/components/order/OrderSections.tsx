import { formatRub } from '@detaly/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  IconArrowRight,
  IconCart,
  IconChevronDown,
  IconClock,
  IconMessage,
} from '@/components/icons';
import { PickupCard } from '@/components/PickupCard';
import type { PickupRoute } from '@/components/PickupRouteLinks';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
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
export type { PickupRoute };

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
 * The code the client names at the pickup point: 40 px, extra bold, spaced digits on a grey
 * `surface` plate (docs/design-v2.md, PickupCode).
 */
export function PickupCodeBlock({ code }: { code: string }) {
  return (
    <section
      className="min-w-0 rounded-tile bg-surface px-5 py-4 text-center"
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
 * Where to collect the order (docs/design-v2.md, «Заказ»): the shared PickupCard (the same as on
 * the home page, /about and /returns) titled «Где забрать», with the pickup code under the title
 * when there is one. The partner's full logo is left to the page-wide card: at the title's size
 * its lettering cannot be read.
 */
export function PickupBlock({
  pickup,
  code = null,
  routes = [],
  className,
}: {
  className?: string;
  pickup: PickupInfo;
  /** The pickup code (from `ready` on). */
  code?: string | null;
  routes?: readonly PickupRoute[];
}) {
  return (
    <PickupCard
      layout="stack"
      title="Где забрать"
      titleId="order-pickup-title"
      testId="order-pickup"
      pickup={pickup}
      routes={routes}
      fallback={PICKUP_ADDRESS_UNKNOWN}
      className={className}
    >
      {code ? <PickupCodeBlock code={code} /> : null}
    </PickupCard>
  );
}

/** Tone of an item's state badge: over and done are told apart from on the way. */
function itemTone(item: OrderItemView): BadgeTone {
  if (item.inactive) return 'neutral';
  return item.state === 'arrived' || item.state === 'handed' ? 'ok' : 'info';
}

function ItemRow({ item }: { item: OrderItemView }) {
  return (
    <li
      className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-x-3 py-3.5"
      data-testid="order-item"
      data-state={item.state}
    >
      <PartTile name={item.name} size="sm" />
      <div className="min-w-0">
        <p className="text-[1.0625rem] leading-snug font-bold wrap-anywhere">
          {item.brand} <span className="tabular-nums">{item.article}</span>
        </p>
        <p className="line-clamp-1 text-small font-normal text-muted wrap-anywhere">{item.name}</p>
      </div>
      <div className="text-right">
        {/* An item out of the order: the sum struck through, the text keeps its contrast. */}
        <p
          className={cn(
            'text-[1.0625rem] font-bold whitespace-nowrap tabular-nums',
            item.inactive && 'text-muted line-through',
          )}
        >
          {formatRub(item.lineTotalKop)}
        </p>
        <p className="text-small font-normal whitespace-nowrap text-muted tabular-nums">
          {item.qty} × {formatRub(item.priceClientKop)}
        </p>
      </div>
      {/* One badge, like everywhere, under the name and the sum (it may be long): the item's
          state once the order is confirmed, before that where it comes from. Never «склад»
          next to «едет к нам». */}
      {item.stateLabel ? (
        <p className="col-span-2 col-start-2 mt-1.5">
          <Badge tone={itemTone(item)} data-testid="order-item-state">
            {item.stateLabel}
          </Badge>
        </p>
      ) : item.isLocal ? (
        <p className="col-span-2 col-start-2 mt-1.5">
          <Badge tone="ok">Со склада в Оренбурге</Badge>
        </p>
      ) : null}
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
      icon={<IconCart size={24} />}
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
  if (bare) {
    // Inside the notifications card: folded, the card itself stays two buttons and a line.
    return (
      <details className="details-plain group mt-4 border-t border-line pt-3">
        <summary className="inline-flex min-h-11 items-center gap-1 text-small font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          Как выглядит сообщение
          <IconChevronDown
            size={18}
            className="shrink-0 text-muted transition-transform duration-150 group-open:rotate-180"
          />
        </summary>
        <div className="pt-2">{body}</div>
      </details>
    );
  }
  return (
    <Card title="Уведомления о статусе" icon={<IconMessage size={24} />} testId="order-messengers">
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
