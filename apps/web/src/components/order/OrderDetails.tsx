import type { CartReminder } from '@/server/orders/cart-reminder';
import type { OrderView } from '@/server/orders/order-view';
import { CancelOrderForm } from './CancelOrderForm';
import {
  CartReminderBanner,
  ItemsBlock,
  MessengerStubs,
  PaymentBlock,
  PickupBlock,
  PickupCodeBlock,
  StatusBadge,
  TimelineBlock,
  type PickupInfo,
} from './OrderSections';

/**
 * /o/<token> (docs/phase-1a-implementation.md 7.1). Presentational: everything comes from
 * the read model; the client's phone is not part of it and is never shown.
 */
export function OrderDetails({
  view,
  pickup,
  contactPhone,
  cartReminder,
}: {
  view: OrderView;
  pickup: PickupInfo;
  contactPhone: string | null;
  cartReminder: CartReminder | null;
}) {
  return (
    <div className="mx-auto max-w-2xl min-w-0 space-y-4" data-testid="order-page">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold md:text-3xl" data-testid="order-number">
          Заказ {view.number}
        </h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatusBadge label={view.statusLabel} tone={view.statusTone} />
          {view.promiseText ? (
            <span className="text-base" data-testid="order-promise">
              Получение <span className="font-semibold">{view.promiseText}</span>
            </span>
          ) : null}
        </div>
      </header>

      {cartReminder ? <CartReminderBanner reminder={cartReminder} /> : null}

      {view.pickupCode ? <PickupCodeBlock code={view.pickupCode} /> : null}

      <PaymentBlock scheme={view.scheme} status={view.status} totalKop={view.totalKop} />

      <ItemsBlock
        items={view.items}
        subtotalKop={view.subtotalKop}
        courierFeeKop={view.courierFeeKop}
        totalKop={view.totalKop}
      />

      {view.fulfillment === 'pickup' ? <PickupBlock pickup={pickup} /> : null}

      <TimelineBlock entries={view.timeline} />

      {view.closed ? null : <MessengerStubs preferred={view.preferredChannel} />}

      {view.canCancel ? <CancelOrderForm token={view.token} contactPhone={contactPhone} /> : null}
    </div>
  );
}
