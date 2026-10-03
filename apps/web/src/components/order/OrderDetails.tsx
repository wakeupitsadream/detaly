import { formatRub } from '@detaly/domain';
import type { ReactNode } from 'react';
import { IconCard, IconClock, IconLift } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { PageBand, PageBody } from '@/components/page/PageBand';
import { FullBleed } from '@/components/ui/Section';
import { InstallBookingBlock } from '@/components/install/InstallBookingBlock';
import type { InstallPlanView } from '@/server/install/types';
import type { CartReminder } from '@/server/orders/cart-reminder';
import type { OrderFlash } from '@/server/orders/flash';
import type { MessengerView, OrderServicesView } from '@/server/orders/order-services';
import type { OrderView } from '@/server/orders/order-view';
import { payCheckState, type PayNotice } from '@/server/orders/pay-notice';
import { CancelOrderForm } from './CancelOrderForm';
import { ClaimBlock } from './ClaimBlock';
import { MessengerBlock } from './MessengerBlock';
import { OrderPhotos } from './OrderPhotos';
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
  MessengerPreview,
  PickupBlock,
  PickupCodeBlock,
  StatusBadge,
  TimelineBlock,
  type PickupInfo,
} from './OrderSections';
import { OrderStepper } from './OrderStepper';

const NO_NOTICE: PayNotice = { paid: false, payError: null, since: null };

/** Without the 1C read model (tests of the 1A/1B page): the inactive Telegram stub. */
const NO_MESSENGER: MessengerView = { telegram: 'none', telegramAvailable: false };

/** No messenger block for an order that is over without a handover. */
const NO_NOTIFY = new Set(['cancelled', 'refunded']);

/** A flash message of the last form post, shown inside the block it belongs to. */
function FlashNotice({ flash }: { flash: OrderFlash }) {
  return (
    <Notice
      tone={flash.tone}
      className="mb-4"
      role={flash.tone === 'danger' ? 'alert' : 'status'}
      data-testid="order-flash"
      data-code={flash.code}
    >
      {flash.text}
    </Notice>
  );
}

/** Statuses at which the order has stopped: the stepper greys out and a danger plate says so. */
const STOPPED = new Set(['cancelled', 'refund_pending', 'refunded']);

/** One fact of the work order head: an icon and a line in the text face. */
function HeadFact({
  icon,
  children,
  testId,
}: {
  icon: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span
      className="inline-flex min-w-0 items-start gap-2 text-paper md:text-[1.0625rem]"
      data-testid={testId}
    >
      <span className="mt-0.5 shrink-0 text-steel-400 md:mt-1">{icon}</span>
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** How the order is paid, as one line of the head: the card below only carries actions. */
function paymentLine(view: OrderView): ReactNode {
  const total = <span className="font-semibold whitespace-nowrap">{formatRub(view.totalKop)}</span>;
  if (view.scheme === 'prepay') {
    return view.moneyHeld ? <>Оплачено онлайн · {total}</> : <>Предоплата онлайн · {total}</>;
  }
  return <>Оплата при получении · {total}, картой или по QR</>;
}

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
  services,
  flash = null,
  demo = false,
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
  /** Phase 1C blocks (notifications, installation booking, claims, photos). */
  services?: OrderServicesView;
  /** Flash message after a form post (?flash=<code>). */
  flash?: OrderFlash | null;
  /** The sample order of DEMO_MODE: a preview of a status message under the buttons. */
  demo?: boolean;
}) {
  const check = payCheckState(view, notice, nowMs);
  const stopped = STOPPED.has(view.status);
  const showInstall = view.fulfillment === 'pickup' && !view.closed && install !== undefined;
  const flashFor = (section: OrderFlash['section']) =>
    flash !== null && flash.section === section ? <FlashNotice flash={flash} /> : undefined;
  const messenger = NO_NOTIFY.has(view.status) ? null : (services?.messenger ?? NO_MESSENGER);
  // A flash whose block is not on the page (e.g. the booking closed meanwhile) goes on top.
  const flashHome =
    flash === null
      ? true
      : flash.section === 'claim'
        ? Boolean(services?.claims)
        : flash.section === 'install'
          ? Boolean(services?.install)
          : messenger !== null;
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
        <div className="flex min-w-0 flex-col items-start gap-3 md:flex-row md:flex-wrap md:items-center md:gap-x-7">
          <StatusBadge label={view.statusLabel} tone={view.statusTone} />
          {view.promiseText ? (
            <HeadFact icon={<IconClock size={18} />} testId="order-promise">
              Получение <span className="font-semibold">{view.promiseText}</span>
            </HeadFact>
          ) : null}
          {showInstall && install ? (
            <HeadFact icon={<IconLift size={18} />} testId="order-car-ready">
              Подъёмник <time dateTime={install.slotStartIso}>{install.slotText}</time> · машина
              готова <span className="font-semibold">{install.carReadyText}</span>
            </HeadFact>
          ) : null}
          {stopped ? null : (
            <HeadFact icon={<IconCard size={18} />} testId="order-payment-line">
              {paymentLine(view)}
            </HeadFact>
          )}
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
        {flash !== null && !flashHome ? <FlashNotice flash={flash} /> : null}
        {cartReminder ? <CartReminderBanner reminder={cartReminder} /> : null}

        <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-start lg:gap-8">
          {/* Left: decisions, money and the parts; the notifications close it. Right: where to
              come and what happened. One column on phones, in this order. */}
          <div className="min-w-0 space-y-5">
            <ApprovalBlock view={view} contactPhone={contactPhone} />

            {view.pickupCode ? <PickupCodeBlock code={view.pickupCode} /> : null}

            <PaymentBlock view={view} notice={notice} check={check} contactPhone={contactPhone} />

            {services?.claims ? (
              <ClaimBlock
                token={view.token}
                block={services.claims}
                pickup={pickup}
                contactPhone={contactPhone}
                notice={flashFor('claim')}
              />
            ) : null}

            <RefundBlock view={view} />

            <PartialArrivalBlock view={view} contactPhone={contactPhone} />

            {services?.install ? (
              <InstallBookingBlock
                token={view.token}
                install={services.install}
                notice={flashFor('install')}
              />
            ) : null}

            <ItemsBlock
              items={view.items}
              subtotalKop={view.subtotalKop}
              courierFeeKop={view.courierFeeKop}
              totalKop={view.totalKop}
            />

            {messenger ? (
              <MessengerBlock
                token={view.token}
                messenger={messenger}
                preferred={view.preferredChannel}
                demo={demo}
                notice={flashFor('notify')}
                preview={
                  demo ? (
                    <MessengerPreview
                      number={view.number}
                      install={install ?? null}
                      hours={pickup.hours}
                      bare
                    />
                  ) : undefined
                }
              />
            ) : null}
          </div>

          <div className="min-w-0 space-y-5 lg:sticky lg:top-24">
            {view.fulfillment === 'pickup' ? (
              <PickupBlock pickup={pickup} install={view.closed ? undefined : install} />
            ) : null}

            {services ? <OrderPhotos photos={services.photos} demo={services.demo} /> : null}

            <TimelineBlock entries={view.timeline} />

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
