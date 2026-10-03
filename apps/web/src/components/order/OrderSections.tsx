import { formatRub } from '@detaly/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  IconArrowRight,
  IconClock,
  IconLift,
  IconMessage,
  IconPhone,
  IconPin,
} from '@/components/icons';
import { SheetTitle } from '@/components/page/SheetTitle';
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

const TONE_BADGE: Record<StatusTone, BadgeTone> = {
  wait: 'wait',
  progress: 'info',
  success: 'ok',
  stopped: 'neutral',
};

export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <Badge
      tone={TONE_BADGE[tone]}
      className="min-h-7 px-2.5 text-sm font-semibold"
      data-testid="order-status"
    >
      {label}
    </Badge>
  );
}

/** A sheet of the order page: card on paper with a display-face title and a hairline. */
export function Card({
  title,
  children,
  testId,
  aside,
  tight = false,
  className,
  id,
}: {
  title?: string;
  children: ReactNode;
  testId?: string;
  aside?: ReactNode;
  /** The content (a list with its own padding) starts right under the title's hairline. */
  tight?: boolean;
  className?: string;
  /** Anchor of the block (#install, #claim, #notify, #decision): forms redirect back to it. */
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        'min-w-0 scroll-mt-24 rounded border border-line bg-card p-5 md:p-6',
        className,
      )}
      data-testid={testId}
    >
      {title ? (
        <SheetTitle aside={aside} tight={tight}>
          {title}
        </SheetTitle>
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
 * The nearest lift slot after the order's date: a calculation, not a booking. The master
 * confirms the slot; the installation is the service's own work and is paid there.
 */
function InstallSlot({ plan }: { plan: InstallPlanView | null }) {
  return (
    <div className="mt-5 rounded-sm border border-line bg-paper p-4" data-testid="order-install">
      <p className="flex min-w-0 items-start gap-2 text-sm">
        <IconLift size={18} className="mt-px shrink-0" />
        <span className="min-w-0">
          Ближайшее окно установки:{' '}
          {plan ? (
            <>
              <time dateTime={plan.slotStartIso} className="font-semibold">
                {plan.slotText}
              </time>
              , машина готова {plan.carReadyText}
            </>
          ) : (
            <span className="font-semibold">подберём при записи</span>
          )}
        </span>
      </p>
      <p className="mt-2 text-sm text-muted">
        Запись подтверждает мастер; установка&nbsp;— услуга сервиса, оплачивается там.
      </p>
      {plan?.demo ? (
        <Badge tone="demo" className="mt-3">
          загрузка демонстрационная
        </Badge>
      ) : null}
    </div>
  );
}

export function PickupBlock({
  pickup,
  install,
}: {
  pickup: PickupInfo;
  /** Install slot by the order's date; undefined: not shown (closed order, no date). */
  install?: InstallPlanView | null;
}) {
  const empty = !pickup.name && !pickup.address && !pickup.hours && !pickup.phone;
  return (
    <Card title="Самовывоз" testId="order-pickup">
      {empty ? (
        <p className="text-muted">{PICKUP_ADDRESS_UNKNOWN}</p>
      ) : (
        <address className="flex min-w-0 gap-3 not-italic">
          <IconPin size={20} className="mt-0.5 shrink-0 text-accent-ink" />
          <div className="min-w-0 space-y-1">
            {pickup.name ? <p className="font-semibold wrap-anywhere">{pickup.name}</p> : null}
            {pickup.address ? <p className="wrap-anywhere">{pickup.address}</p> : null}
            {pickup.hours ? (
              <p className="flex items-center gap-1.5 text-sm text-muted wrap-anywhere">
                <IconClock size={14} className="shrink-0" />
                {pickup.hours}
              </p>
            ) : null}
            {pickup.phone ? (
              <p>
                <a
                  className="inline-flex min-h-9 items-center gap-1.5 font-medium underline underline-offset-4"
                  href={phoneHref(pickup.phone)}
                >
                  <IconPhone size={15} className="shrink-0" />
                  {pickup.phone}
                </a>
              </p>
            ) : null}
          </div>
        </address>
      )}
      {install !== undefined ? <InstallSlot plan={install} /> : null}
    </Card>
  );
}

function ItemRow({ item }: { item: OrderItemView }) {
  return (
    <li
      className={cn(
        'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 py-4 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]',
        item.inactive && 'opacity-55',
      )}
      data-testid="order-item"
      data-state={item.state}
    >
      <PartTile name={item.name} size="sm" className="hidden sm:grid" />
      <div className="min-w-0">
        <p className="text-label text-muted wrap-anywhere">{item.brand}</p>
        <p className="mt-0.5 font-mono font-semibold tracking-wide wrap-anywhere">{item.article}</p>
        <p className="text-sm wrap-anywhere">{item.name}</p>
        {item.isLocal ? <p className="mt-1.5 text-label text-muted">Склад в Оренбурге</p> : null}
        {item.stateLabel ? (
          <p className="mt-1.5 text-sm font-medium text-info" data-testid="order-item-state">
            {item.stateLabel}
          </p>
        ) : null}
      </div>
      <div className="text-right">
        <p className="font-semibold whitespace-nowrap tabular-nums">
          {formatRub(item.lineTotalKop)}
        </p>
        <p className="mt-0.5 font-mono text-xs whitespace-nowrap text-muted">
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
      aside={<span className="font-mono text-xs text-muted">{items.length} поз.</span>}
    >
      <ul className="divide-y divide-dashed divide-line">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
      <dl className="mt-1 space-y-1.5 border-t border-ink pt-4">
        {courierFeeKop > 0 ? (
          <>
            <div className="flex justify-between gap-3 text-sm text-muted">
              <dt>Запчасти</dt>
              <dd className="whitespace-nowrap tabular-nums">{formatRub(subtotalKop)}</dd>
            </div>
            <div className="flex justify-between gap-3 text-sm text-muted">
              <dt>Доставка</dt>
              <dd className="whitespace-nowrap tabular-nums">{formatRub(courierFeeKop)}</dd>
            </div>
          </>
        ) : null}
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-label text-muted">Итого</dt>
          <dd>
            <Price data-testid="order-total">{formatRub(totalKop)}</Price>
          </dd>
        </div>
      </dl>
    </Card>
  );
}

export function TimelineBlock({ entries }: { entries: readonly TimelineEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <Card title="История заказа" testId="order-timeline">
      <ol className="relative space-y-4 border-l border-line-strong pl-5">
        {entries.map((entry, index) => (
          <li key={entry.id} className="relative flex min-w-0 flex-col gap-0.5">
            <span
              aria-hidden
              className={cn(
                'absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-card',
                index === entries.length - 1 ? 'bg-accent' : 'bg-ink',
              )}
            />
            <time dateTime={entry.at} className="font-mono text-xs text-muted">
              {entry.timeText}
            </time>
            <span className="wrap-anywhere">{entry.text}</span>
          </li>
        ))}
      </ol>
    </Card>
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
      <p className="text-sm text-muted">
        {bare
          ? 'Так выглядит сообщение бота, когда детали приедут:'
          : 'Статусы приходят в MAX или Telegram. Так выглядит сообщение, когда детали приедут:'}
      </p>
      <div
        className="mt-4 rounded border border-line bg-paper-2 p-4"
        data-testid="messenger-preview"
      >
        <p className="flex items-center gap-2 text-label text-muted">
          <IconMessage size={15} className="shrink-0 text-ink" />
          Бот магазина
        </p>
        <div className="mt-3 max-w-md rounded-sm rounded-tl-none border border-line bg-card px-4 py-3">
          <p className="leading-relaxed">
            Заказ {number}: детали приехали. {when}
          </p>
          <p className="mt-1.5 text-right font-mono text-xs text-muted">09:05</p>
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
      className="group flex min-w-0 items-center justify-between gap-3 rounded-sm border border-l-[3px] border-info/20 border-l-info bg-info-soft px-4 py-3 font-medium text-ink"
      data-testid="cart-reminder"
    >
      <span className="min-w-0 underline-offset-4 group-hover:underline">{reminder.text}</span>
      <IconArrowRight size={18} className="shrink-0 text-info" />
    </Link>
  );
}

export function PickupCodeBlock({ code }: { code: string }) {
  return (
    <section
      className="grain-dark corner-marks min-w-0 rounded border border-graphite-700 bg-graphite-900 p-5 text-steel-200 md:p-6"
      style={{ ['--corner-color' as string]: 'var(--color-accent)' }}
      data-testid="order-pickup-code"
    >
      <h2 className="text-label text-steel-400">Код выдачи</h2>
      <p className="mt-2 font-mono text-4xl font-semibold tracking-[0.25em] text-paper tabular-nums md:text-5xl">
        {code}
      </p>
      <p className="mt-2 text-sm text-steel-400">Назовите код в пункте выдачи.</p>
    </section>
  );
}
