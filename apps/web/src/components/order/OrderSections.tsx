import { formatRub, type NotificationChannel, type PaymentScheme } from '@detaly/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { CartReminder } from '@/server/orders/cart-reminder';
import type { OrderItemView, OrderView } from '@/server/orders/order-view';
import type { StatusTone } from '@/server/orders/status-labels';
import type { TimelineEntry } from '@/server/orders/timeline';

/** Pickup point from env (PICKUP_*): any field may be missing. */
export interface PickupInfo {
  name: string | null;
  address: string | null;
  hours: string | null;
  phone: string | null;
}

const TONE_CLASSES: Record<StatusTone, string> = {
  wait: 'bg-warn-soft text-warn',
  progress: 'bg-order-soft text-order',
  success: 'bg-local-soft text-local',
  stopped: 'bg-line text-muted',
};

export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <span
      className={`inline-flex max-w-full items-center rounded-full px-3 py-1 text-sm font-semibold ${TONE_CLASSES[tone]}`}
      data-testid="order-status"
    >
      {label}
    </span>
  );
}

function Card({
  title,
  children,
  testId,
}: {
  title?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="min-w-0 rounded-card border border-line bg-card p-4 md:p-5"
      data-testid={testId}
    >
      {title ? <h2 className="mb-3 text-lg font-semibold">{title}</h2> : null}
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

export function PickupBlock({ pickup }: { pickup: PickupInfo }) {
  const empty = !pickup.name && !pickup.address && !pickup.hours && !pickup.phone;
  return (
    <Card title="Самовывоз" testId="order-pickup">
      {empty ? (
        <p className="text-muted">{PICKUP_ADDRESS_UNKNOWN}</p>
      ) : (
        <address className="space-y-1.5 text-base not-italic">
          {pickup.name ? <p className="font-medium wrap-anywhere">{pickup.name}</p> : null}
          {pickup.address ? <p className="wrap-anywhere">{pickup.address}</p> : null}
          {pickup.hours ? <p className="text-muted wrap-anywhere">{pickup.hours}</p> : null}
          {pickup.phone ? (
            <p>
              <a className="font-medium underline" href={phoneHref(pickup.phone)}>
                {pickup.phone}
              </a>
            </p>
          ) : null}
        </address>
      )}
    </Card>
  );
}

export function PaymentBlock({
  scheme,
  status,
  totalKop,
}: {
  scheme: PaymentScheme;
  status: OrderView['status'];
  totalKop: number;
}) {
  if (scheme === 'prepay') {
    return (
      <Card title="Оплата" testId="order-payment">
        <p className="font-medium">Предоплата 100% онлайн</p>
        {status === 'awaiting_payment' ? (
          <>
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="mt-3 inline-flex h-11 w-full cursor-not-allowed items-center justify-center rounded-xl bg-accent px-5 font-semibold text-white opacity-50 sm:w-auto"
              data-testid="pay-button"
            >
              Оплатить {formatRub(totalKop)}
            </button>
            <p className="mt-2 text-sm text-muted">
              Оплата подключается — пришлём ссылку, как только она заработает.
            </p>
          </>
        ) : null}
      </Card>
    );
  }
  return (
    <Card title="Оплата" testId="order-payment">
      <p className="font-medium">Оплата при получении картой или по QR</p>
      {status === 'awaiting_confirmation' ? (
        <p className="mt-2 text-sm text-muted">
          Подтверждение заказа подключается: мы свяжемся с вами.
        </p>
      ) : null}
    </Card>
  );
}

function ItemRow({ item }: { item: OrderItemView }) {
  return (
    <li
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-3"
      data-testid="order-item"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-wide text-muted uppercase wrap-anywhere">
          {item.brand}
        </div>
        <div className="font-mono font-semibold wrap-anywhere">{item.article}</div>
        <div className="text-sm wrap-anywhere">{item.name}</div>
      </div>
      <div className="text-right">
        <div className="font-semibold whitespace-nowrap">{formatRub(item.lineTotalKop)}</div>
        <div className="text-sm whitespace-nowrap text-muted">
          {item.qty} × {formatRub(item.priceClientKop)}
        </div>
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
    <Card title="Состав заказа" testId="order-items">
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
      <dl className="mt-2 space-y-1 border-t border-line pt-3">
        {courierFeeKop > 0 ? (
          <>
            <div className="flex justify-between gap-3 text-muted">
              <dt>Запчасти</dt>
              <dd className="whitespace-nowrap">{formatRub(subtotalKop)}</dd>
            </div>
            <div className="flex justify-between gap-3 text-muted">
              <dt>Доставка</dt>
              <dd className="whitespace-nowrap">{formatRub(courierFeeKop)}</dd>
            </div>
          </>
        ) : null}
        <div className="flex justify-between gap-3 text-lg font-bold">
          <dt>Итого</dt>
          <dd className="whitespace-nowrap" data-testid="order-total">
            {formatRub(totalKop)}
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
      <ol className="space-y-3">
        {entries.map((entry) => (
          <li key={entry.id} className="flex min-w-0 flex-col gap-0.5 border-l-2 border-line pl-3">
            <time dateTime={entry.at} className="text-sm text-muted">
              {entry.timeText}
            </time>
            <span className="wrap-anywhere">{entry.text}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

const MESSENGERS = [
  { channel: 'max', label: 'Статусы в MAX' },
  { channel: 'telegram', label: 'Статусы в Telegram' },
] as const satisfies readonly { channel: NotificationChannel; label: string }[];

/**
 * Messenger binding buttons: inactive stubs until phase 1C (no link_tokens are created).
 * The channel chosen at checkout is highlighted.
 */
export function MessengerStubs({ preferred }: { preferred: NotificationChannel | null }) {
  return (
    <Card title="Уведомления о статусе" testId="order-messengers">
      <div className="grid gap-2 sm:grid-cols-2">
        {MESSENGERS.map(({ channel, label }) => {
          const selected = preferred === channel;
          return (
            <button
              key={channel}
              type="button"
              disabled
              aria-disabled="true"
              className={`flex h-auto min-h-11 cursor-not-allowed flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-2 text-left font-medium ${
                selected
                  ? 'border-accent bg-accent-soft text-ink'
                  : 'border-line bg-paper text-muted'
              }`}
              data-testid={`messenger-${channel}`}
              data-selected={selected ? 'true' : 'false'}
            >
              <span>{label}</span>
              <span className="rounded-full bg-line px-2 py-0.5 text-xs text-muted">скоро</span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-sm text-muted">
        {preferred === 'sms'
          ? 'Вы выбрали SMS. Уведомления подключаются — пока следите за заказом на этой странице.'
          : 'Уведомления подключаются — пока следите за заказом на этой странице.'}{' '}
        Сохраните ссылку: по ней видно статус заказа.
      </p>
    </Card>
  );
}

export function CartReminderBanner({ reminder }: { reminder: CartReminder }) {
  return (
    <Link
      href={reminder.href}
      className="block rounded-card border border-order/30 bg-order-soft px-4 py-3 font-medium text-order underline-offset-2 hover:underline"
      data-testid="cart-reminder"
    >
      {reminder.text}
    </Link>
  );
}

export function PickupCodeBlock({ code }: { code: string }) {
  return (
    <Card title="Код выдачи" testId="order-pickup-code">
      <p className="font-mono text-3xl font-bold tracking-widest">{code}</p>
      <p className="mt-1 text-sm text-muted">Назовите код в пункте выдачи.</p>
    </Card>
  );
}
