import { formatRub } from '@detaly/domain';
import type { ReactNode } from 'react';
import { IconCalendar, IconCard, IconLock, IconWallet, IconWrench } from '@/components/icons';
import { InstallLine } from '@/components/install/InstallLine';
import { InstallBookingBlock } from '@/components/install/InstallBookingBlock';
import { Notice } from '@/components/page/Notice';
import { PageBand, PageBody } from '@/components/page/PageBand';
import { Badge } from '@/components/ui/Badge';
import { FullBleed } from '@/components/ui/Section';
import type { InstallPlanView } from '@/server/install/types';
import type { CartReminder } from '@/server/orders/cart-reminder';
import type { OrderFlash } from '@/server/orders/flash';
import type { MessengerView, OrderServicesView } from '@/server/orders/order-services';
import type { OrderView } from '@/server/orders/order-view';
import { payCheckState, type PayNotice } from '@/server/orders/pay-notice';
import type { ReviewLink } from '@/server/reviews/links';
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
  Card,
  CartReminderBanner,
  ItemsBlock,
  MessengerPreview,
  PickupBlock,
  PickupCodeBlock,
  StatusBadge,
  TimelineBlock,
  type PickupInfo,
  type PickupRoute,
} from './OrderSections';
import { OrderStepper } from './OrderStepper';
import { REVIEW_CARD_STATUSES, ReviewCard } from './ReviewCard';

/**
 * One column on phones in reading order. From lg two: everything in the left column, and on the
 * right, spanning all rows (`row-span-30`; the rows the page does not fill are empty and take
 * no room, so the gaps are margins of the items), where to collect the order with its code and
 * the installation booking under it. Not sticky: the two cards together can be taller than the
 * screen under the sticky search plate, and a stuck column would hide the booking button.
 */
const GRID =
  'grid min-w-0 gap-y-4 md:gap-y-5 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-x-8 lg:gap-y-0 lg:[&>*]:col-start-1 lg:[&>*]:mb-5';
const SIDE =
  'grid min-w-0 gap-4 md:gap-5 lg:col-start-2! lg:row-span-30 lg:row-start-1 lg:mb-0! lg:self-start';

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

/** How the order is paid, as one line of the head: the card below only carries actions. */
function paymentLine(view: OrderView): ReactNode {
  const total = <span className="font-bold whitespace-nowrap">{formatRub(view.totalKop)}</span>;
  if (view.scheme === 'prepay') {
    return view.moneyHeld ? <>Оплачено онлайн · {total}</> : <>Предоплата онлайн · {total}</>;
  }
  return <>Оплата при получении · {total}, по QR-коду с вашего телефона</>;
}

/**
 * The «Машина готова …» line of the order, or the note when there is no slot to book here. The
 * calculation is not a booking: the master confirms the slot.
 */
function InstallCard({ plan }: { plan: InstallPlanView | null }) {
  return (
    <Card title="Установка" icon={<IconWrench size={24} />} testId="order-install">
      <div data-testid="order-car-ready">
        <InstallLine plan={plan} size="md" />
      </div>
      <p className="mt-2 text-small font-normal text-muted">
        Запись подтверждает мастер; установка — услуга сервиса, оплата там.
      </p>
      {plan?.demo ? (
        <Badge tone="demo" className="mt-3">
          Демо: время условное
        </Badge>
      ) : null}
    </Card>
  );
}

/**
 * /o/<token> (docs/phase-1a-implementation.md 7.1, phase 1B section 14.4; docs/design-v2.md,
 * «Заказ»). Presentational: everything comes from the read model; the client's phone is not
 * part of it and is never shown. `notice` carries the query flags after the payment page
 * (?paid=1, ?pay=error).
 *
 * One column, like a receipt: the head (number, a large status badge, the date and how it is
 * paid), the stepper, whatever needs the client's decision or money, where to collect it (the
 * pickup code), the installation line with the booking chips, the parts, the claims, then the
 * secondary actions (statuses in a messenger, cancel, refuse) and the folded history. Step 3:
 * after the handover «Оцените нас» stands below all of it, above the history (ReviewCard).
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
  routes = [],
  reviews = [],
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
  /** Route links to the pickup point (pickupRoutes(brand)). */
  routes?: readonly PickupRoute[];
  /** Step 3: the review buttons (orderReviewLinks); the card shows after the handover. */
  reviews?: readonly ReviewLink[];
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
  const installLine =
    showInstall && install !== undefined ? (
      // The booking card below says «Демо» once for the line and the slots.
      <div data-testid="order-car-ready">
        <InstallLine plan={install} size="md" icon={false} />
      </div>
    ) : undefined;
  const PayIcon = view.scheme === 'prepay' ? IconCard : IconWallet;
  return (
    <FullBleed data-testid="order-page">
      <div>
        <PageBand
          tone="light"
          eyebrow={
            <span className="inline-flex items-center gap-1.5">
              <IconLock size={18} className="shrink-0" />
              Сохраните ссылку — по ней виден заказ
            </span>
          }
          titleTestId="order-number"
          title={
            <>
              Заказ <span className="whitespace-nowrap tabular-nums">{view.number}</span>
            </>
          }
        >
          <div className="flex min-w-0 flex-col items-start gap-3">
            <StatusBadge label={view.statusLabel} tone={view.statusTone} />
            {view.promiseText ? (
              <p className="flex min-w-0 items-center gap-2.5 text-h3" data-testid="order-promise">
                <IconCalendar size={28} className="shrink-0 text-brand" />
                <span className="min-w-0">
                  Получение <span className="whitespace-nowrap">{view.promiseText}</span>
                </span>
              </p>
            ) : null}
            {stopped ? null : (
              <p
                className="flex min-w-0 items-start gap-2.5 text-body"
                data-testid="order-payment-line"
              >
                <PayIcon size={24} className="shrink-0 text-brand" />
                <span className="min-w-0">{paymentLine(view)}</span>
              </p>
            )}
          </div>
        </PageBand>
      </div>

      <div>
        <PageBody className={GRID}>
          <section
            className="min-w-0 rounded-tile border border-line bg-bg px-5 py-5 md:px-6 md:py-7"
            aria-label="Ход заказа"
          >
            <OrderStepper status={view.status} scheme={view.scheme} />
          </section>

          {stopped ? (
            <Notice tone="danger" title={view.statusLabel} data-testid="order-stopped">
              Заказ остановлен. Что и когда произошло — в истории заказа ниже.
            </Notice>
          ) : null}
          {flash !== null && !flashHome ? <FlashNotice flash={flash} /> : null}
          {cartReminder ? <CartReminderBanner reminder={cartReminder} /> : null}

          <ApprovalBlock view={view} contactPhone={contactPhone} />
          <PaymentBlock view={view} notice={notice} check={check} contactPhone={contactPhone} />
          <RefundBlock view={view} />
          <PartialArrivalBlock view={view} contactPhone={contactPhone} />

          <div className={SIDE}>
            {view.fulfillment === 'pickup' ? (
              <PickupBlock
                pickup={pickup}
                code={view.pickupCode}
                keepUntil={view.keepUntilText}
                routes={routes}
              />
            ) : view.pickupCode ? (
              <PickupCodeBlock code={view.pickupCode} />
            ) : null}

            {services?.install ? (
              <InstallBookingBlock
                token={view.token}
                install={services.install}
                notice={flashFor('install')}
                lead={installLine}
              />
            ) : showInstall && install !== undefined ? (
              <InstallCard plan={install} />
            ) : null}
          </div>

          <ItemsBlock
            items={view.items}
            subtotalKop={view.subtotalKop}
            courierFeeKop={view.courierFeeKop}
            totalKop={view.totalKop}
            vehicle={view.vehicle}
          />

          {services ? <OrderPhotos photos={services.photos} /> : null}

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

          {view.canCancel || view.actions.refuse ? (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              {view.canCancel ? (
                <CancelOrderForm token={view.token} contactPhone={contactPhone} />
              ) : null}
              <RefuseBlock view={view} contactPhone={contactPhone} />
            </div>
          ) : null}

          {/* A claim is an action at the bottom of the page with cancel and refuse, not a card
              next to the items: an order on its way must not look like something went wrong. */}
          {services?.claims ? (
            <ClaimBlock
              token={view.token}
              block={services.claims}
              pickup={pickup}
              contactPhone={contactPhone}
              notice={flashFor('claim')}
            />
          ) : null}

          {/* Below every action the client may need, the same for everyone (step 3). */}
          {REVIEW_CARD_STATUSES.has(view.status) ? <ReviewCard links={reviews} /> : null}

          <TimelineBlock entries={view.timeline} />
        </PageBody>
      </div>
    </FullBleed>
  );
}
