/**
 * The sample order of the demo (/o/demo, DEMO_MODE has no orders table): a regular OrderView
 * rendered by the same components as /o/<token>. Two positions come from the supplier
 * fixtures with the prices and dates the search shows right now; the status is «Заказан у
 * поставщика» with the three events that lead there, worded by the real timeline.
 *
 * Nothing here is a client's data: no phone, no name, no requisites, and no buttons (every
 * client action is off, the order API does not exist in the demo).
 *
 * Phase 1C (docs/phase-1c-implementation.md decision С21, section 12): buildDemoOrderServices
 * adds the notification, installation and claim blocks of the sample order. Their forms are
 * GETs to /o/demo?demo=<what> whose personal fields (the claim text, the phone digits, the
 * photos) carry no `name`, so nothing personal leaves the browser; the `demo` screen then shows
 * what the client would see (a booking, an accepted claim). The proxy's 303 for POST
 * /api/orders/demo/{link,install,claims} stays the second line for a post from elsewhere. The
 * packaging photo is a placeholder without any file.
 */
import {
  buildOfferViews,
  CLAIM_PHOTOS_MAX,
  CLAIM_TEXT_MAX,
  claimDeadline,
  claimKindsAvailable,
  formatPromise,
  promisedDate as promisedDateOf,
  safeMul,
  sumKop,
  type IsoDate,
  type OfferView,
} from '@detaly/domain';
import type { RosskoClient } from '@detaly/rossko';
import { demoSlotsForDate } from '../install/order-slots';
import type { OrderItemView, OrderView } from '../orders/order-view';
import {
  claimCard,
  kindOptions,
  RETURN_MEMO_PDF,
  type OrderServicesView,
} from '../orders/order-services';
import { orderStatusLabel, orderStatusTone } from '../orders/status-labels';
import { buildTimeline, type TimelineEvent } from '../orders/timeline';
import type { SearchSettings } from '../settings';

/** Fixture articles of the two positions: an oil filter and brake pads. */
export const DEMO_ORDER_ARTICLES = ['OC90', 'GDB1330'] as const;

/** The access token of the sample order (real tokens are 16+ characters, never this). */
export const DEMO_ORDER_TOKEN = 'demo';

export const DEMO_ORDER_NUMBER = 'DT-000042';

const ORDER_ID = 'd0000000-0000-4000-8000-00000000a001';
const CLAIM_ID = 'd0000000-0000-4000-8000-00000000c001';
const BOOKING_ID = 'd0000000-0000-4000-8000-00000000d001';
/** The forms of the sample order carry a fixed key: nothing is ever stored for them. */
const DEMO_REQUEST_KEY = 'd0000000-0000-4000-8000-00000000e001';
/**
 * The sample installation partner when neither INSTALL_PARTNER_NAME nor PICKUP_POINT_NAME is set
 * (never a real one). Genitive: it ends the sentence «Установка — услуга …» (installPaymentText).
 */
export const DEMO_INSTALL_PARTNER = { name: 'сервиса-партнёра', requisites: null };
const ITEM_IDS = ['d0000000-0000-4000-8000-00000000b001', 'd0000000-0000-4000-8000-00000000b002'];

const HOUR_MS = 3_600_000;

export interface DemoOrderDeps {
  rossko: Pick<RosskoClient, 'search'>;
  loadSettings: () => Promise<Pick<SearchSettings, 'markupRules' | 'excludedRules' | 'eta'>>;
  now?: Date;
}

/**
 * The offer of the sample order: the requested article from the Orenburg stock, because the
 * order is paid on handover and only Orenburg parts qualify for that (otherwise the page would
 * say «Оплата при получении» next to parts on order). Falls back to the cheapest sellable one.
 */
function pickView(views: readonly OfferView[]): OfferView | null {
  return (
    views.find((view) => !view.isCross && !view.excluded && view.isLocal) ??
    views.find((view) => !view.isCross && !view.excluded) ??
    views.find((view) => !view.excluded) ??
    null
  );
}

export async function buildDemoOrderView(deps: DemoOrderDeps): Promise<OrderView> {
  const now = deps.now ?? new Date();
  const settings = await deps.loadSettings();
  const picked: OfferView[] = [];
  for (const article of DEMO_ORDER_ARTICLES) {
    const { offers } = await deps.rossko.search(article, { priority: 'search' });
    const view = pickView(
      buildOfferViews(offers, {
        markupRules: settings.markupRules,
        excludedRules: settings.excludedRules,
        eta: settings.eta,
        now,
      }),
    );
    if (view) picked.push(view);
  }
  if (picked.length === 0) throw new Error('demo order: no fixture offers');

  const items = picked.map((view, index): OrderItemView => {
    const qty = Math.max(1, view.multiplicity);
    return {
      id: ITEM_IDS[index] ?? ITEM_IDS[0]!,
      brand: view.brand,
      article: view.article,
      name: view.name,
      qty,
      isLocal: view.isLocal,
      priceClientKop: view.priceClientKop,
      lineTotalKop: safeMul(view.priceClientKop, qty),
      state: 'ordered',
      stateLabel: 'Заказана у поставщика',
      waiting: true,
      inactive: false,
      canCancel: false,
    };
  });
  // The same date the cart and checkout promise: the latest supplier date plus the ETA buffer.
  const promisedDate: IsoDate = promisedDateOf(
    picked.map((view) => view.etaDate),
    settings.eta,
  );
  const subtotalKop = sumKop(items.map((item) => item.lineTotalKop));

  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR_MS);
  const events: TimelineEvent[] = [
    {
      id: 'e1',
      type: 'checkout',
      fromStatus: 'draft',
      toStatus: 'awaiting_confirmation',
      actorType: 'client',
      createdAt: at(5),
    },
    {
      id: 'e2',
      type: 'client_confirmed',
      fromStatus: 'awaiting_confirmation',
      toStatus: 'confirmed',
      actorType: 'client',
      createdAt: at(4.75),
    },
    {
      id: 'e3',
      type: 'supplier_checkout_succeeded',
      fromStatus: 'ordering',
      toStatus: 'ordered_at_supplier',
      actorType: 'system',
      createdAt: at(4.5),
    },
  ];
  const itemTitles = new Map(
    items.map((item) => [item.id, { brand: item.brand, article: item.article }]),
  );

  const status = 'ordered_at_supplier';
  return {
    id: ORDER_ID,
    number: DEMO_ORDER_NUMBER,
    token: DEMO_ORDER_TOKEN,
    status,
    statusLabel: orderStatusLabel(status),
    statusTone: orderStatusTone(status),
    scheme: 'pay_on_handover',
    fulfillment: 'pickup',
    promisedDate,
    promiseText: formatPromise(promisedDate),
    subtotalKop,
    courierFeeKop: 0,
    totalKop: subtotalKop,
    items,
    timeline: buildTimeline(events, undefined, itemTitles),
    preferredChannel: 'telegram',
    pickupCode: null,
    canCancel: false,
    closed: false,
    paymentsEnabled: false,
    payment: null,
    actions: {
      pay: false,
      confirm: false,
      approve: false,
      refundRequest: false,
      refuse: false,
      prepayNow: false,
    },
    moneyHeld: false,
    approval: null,
    partialArrival: null,
    refund: null,
  };
}

export type DemoScreen = 'link' | 'install' | 'claim' | null;

export interface DemoServicesInput {
  view: OrderView;
  /** `?demo=` of /o/demo: the screen after a demo form. */
  screen: DemoScreen;
  /** PICKUP_HOURS: the sample slots use the real working hours. */
  hours: string | null;
  /** INSTALL_PARTNER_*: the sample names the real partner when it is configured. */
  partner: { name: string; requisites: string | null } | null;
  now?: Date;
}

/**
 * The 1C blocks of the sample order. Pure: no database, no Redis, no files. The claim form is
 * shown as it looks after the handover (refusal, «не подошла», defect), so a visitor sees the
 * whole path; `screen` replaces a form with the screen that follows it.
 */
export function buildDemoOrderServices(input: DemoServicesInput): OrderServicesView {
  const now = input.now ?? new Date();
  const { view, screen } = input;
  const slots = demoSlotsForDate({ promisedDate: view.promisedDate, now, hours: input.hours });
  const first = slots.slots[0] ?? null;
  const booking =
    screen === 'install' && first !== null
      ? {
          id: BOOKING_ID,
          status: 'requested' as const,
          slot: first,
          canCancel: false,
          cancelUntilText: '',
        }
      : null;
  const openedAt = new Date(now.getTime() - 5 * 60_000);
  const item = view.items[0];
  const claims =
    screen === 'claim'
      ? [
          claimCard({
            id: CLAIM_ID,
            orderId: view.id,
            orderItemId: item?.id ?? null,
            item: item ? { id: item.id, brand: item.brand, article: item.article } : null,
            kind: 'not_fit',
            openedAt,
            deadlineAt: claimDeadline(openedAt),
            decision: null,
            decidedAt: null,
            returnAcceptedAt: null,
            compensationAmountKop: null,
            refundId: null,
            closedAt: null,
            replacementOrderedAt: null,
            photoCount: 0,
            photos: [],
            returnPhotos: [],
            openedVia: 'web',
            decidedVia: null,
            clientText: null,
            decisionText: null,
            overrideReason: null,
            replacementNote: null,
            open: true,
          }),
        ]
      : [];
  return {
    messenger: { telegram: 'none', telegramAvailable: true },
    install: {
      partner: input.partner ?? DEMO_INSTALL_PARTNER,
      booking,
      slots: booking === null ? slots.slots : [],
      emptyReason: booking === null ? slots.reason : null,
      requestKey: DEMO_REQUEST_KEY,
      demo: true,
    },
    claims: {
      form:
        screen === 'claim'
          ? null
          : {
              kinds: kindOptions(['refusal', 'not_fit', 'defect']),
              targets: [
                { value: '', label: 'Весь заказ' },
                ...view.items.map((i) => ({
                  value: i.id,
                  label: `${i.brand} ${i.article} — ${i.name}`,
                })),
              ],
              requestKey: DEMO_REQUEST_KEY,
              maxPhotos: CLAIM_PHOTOS_MAX,
              maxFileMb: 8,
              textMax: CLAIM_TEXT_MAX,
            },
      claims,
      memoUrl: RETURN_MEMO_PDF,
      demo: true,
    },
    photos: [{ id: 'demo-packaging', kind: 'packaging', url: null }],
    demo: true,
  };
}

/**
 * The claim card of the sample order only where a real order would have one: the same
 * claimKindsAvailable as /o/<token> (order-services), by the sample's status. The sample is
 * «Заказан у поставщика», so the page shows no «Претензия» — an order on its way must not look
 * as if something went wrong. `?demo=claim` (the answer to a claim posted from elsewhere) keeps
 * its accepted claim.
 */
export function claimsByStatus(
  services: OrderServicesView,
  input: { view: OrderView; screen: DemoScreen; now: Date },
): OrderServicesView {
  const { view, screen, now } = input;
  if (screen === 'claim') return services;
  const kinds = claimKindsAvailable({
    status: view.status,
    scheme: view.scheme,
    moneyHeld: view.moneyHeld,
    // The sample is never handed over.
    handedAt: null,
    promisedDate: view.promisedDate,
    now,
  });
  return kinds.length > 0 ? services : { ...services, claims: null };
}
