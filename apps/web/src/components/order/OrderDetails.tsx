import { IconClock } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { PageBand, PageBody } from '@/components/page/PageBand';
import { FullBleed } from '@/components/ui/Section';
import type { InstallPlanView } from '@/server/install/types';
import type { CartReminder } from '@/server/orders/cart-reminder';
import type { OrderView } from '@/server/orders/order-view';
import { payCheckState, type PayNotice } from '@/server/orders/pay-notice';
import { CancelOrderForm } from './CancelOrderForm';
import {
  ApprovalBlock,
  PartialArrivalBlock,
  PaymentBlock,
  RefundBlock,
  RefuseBlock,
} from './OrderActions';
import {
  CartReminderBanner,
  ItemsBlock,
  MessengerStubs,
  PickupBlock,
  PickupCodeBlock,
  StatusBadge,
  TimelineBlock,
  type PickupInfo,
} from './OrderSections';
import { OrderStepper } from './OrderStepper';

const NO_NOTICE: PayNotice = { paid: false, payError: null, since: null };

/** Statuses at which the order has stopped: the stepper greys out and a danger plate says so. */
const STOPPED = new Set(['cancelled', 'refund_pending', 'refunded']);

/**
 * /o/<token> (docs/phase-1a-implementation.md 7.1, phase 1B section 14.4). Presentational:
 * everything comes from the read model; the client's phone is not part of it and is never
 * shown. `notice` carries the query flags after the payment page (?paid=1, ?pay=error).
 *
 * Layout: the graphite band is the head of the work order (number, status, date, stepper);
 * below it the decisions and the money on the left, the point, history and the rest on the
 * right (one column on phones, in the same order).
 */
export function OrderDetails({
  view,
  pickup,
  contactPhone,
  cartReminder,
  notice = NO_NOTICE,
  nowMs,
  install,
}: {
  view: OrderView;
  pickup: PickupInfo;
  contactPhone: string | null;
  cartReminder: CartReminder | null;
  notice?: PayNotice;
  /** Clock of the «Проверяем оплату…» window (tests). */
  nowMs?: number;
  /** Nearest lift slot by the order's date; undefined: not shown. */
  install?: InstallPlanView | null;
}) {
  const check = payCheckState(view, notice, nowMs);
  const stopped = STOPPED.has(view.status);
  return (
    <FullBleed data-testid="order-page">
      <PageBand
        eyebrow="Страница заказа · сохраните ссылку"
        titleTestId="order-number"
        title={
          <>
            Заказ <span className="font-mono font-semibold tracking-tight">{view.number}</span>
          </>
        }
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
          <StatusBadge label={view.statusLabel} tone={view.statusTone} />
          {view.promiseText ? (
            <span
              className="inline-flex min-w-0 items-center gap-2 text-paper md:text-lg"
              data-testid="order-promise"
            >
              <IconClock size={18} className="shrink-0 text-steel-400" />
              <span>
                Получение <span className="font-semibold">{view.promiseText}</span>
              </span>
            </span>
          ) : null}
        </div>
        <div className="mt-7 border-t border-graphite-700 pt-6 md:mt-8 md:pt-7">
          <OrderStepper status={view.status} scheme={view.scheme} />
        </div>
      </PageBand>

      <PageBody className="space-y-5">
        {stopped ? (
          <Notice tone="danger" title={view.statusLabel} data-testid="order-stopped">
            Заказ остановлен. Что произошло и когда — в истории заказа ниже.
          </Notice>
        ) : null}
        {cartReminder ? <CartReminderBanner reminder={cartReminder} /> : null}

        <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start lg:gap-8">
          <div className="min-w-0 space-y-5">
            <ApprovalBlock view={view} contactPhone={contactPhone} />

            {view.pickupCode ? <PickupCodeBlock code={view.pickupCode} /> : null}

            <PaymentBlock view={view} notice={notice} check={check} contactPhone={contactPhone} />

            <RefundBlock view={view} />

            <PartialArrivalBlock view={view} contactPhone={contactPhone} />

            <ItemsBlock
              items={view.items}
              subtotalKop={view.subtotalKop}
              courierFeeKop={view.courierFeeKop}
              totalKop={view.totalKop}
            />
          </div>

          <div className="min-w-0 space-y-5">
            {view.fulfillment === 'pickup' ? (
              <PickupBlock pickup={pickup} install={view.closed ? undefined : install} />
            ) : null}

            <TimelineBlock entries={view.timeline} />

            {view.closed ? null : <MessengerStubs preferred={view.preferredChannel} />}

            <RefuseBlock view={view} contactPhone={contactPhone} />

            {view.canCancel ? (
              <CancelOrderForm token={view.token} contactPhone={contactPhone} />
            ) : null}
          </div>
        </div>
      </PageBody>
    </FullBleed>
  );
}
