/**
 * The sample order of the demo (/o/demo, DEMO_MODE has no orders table): a regular OrderView
 * rendered by the same components as /o/<token>. Two positions come from the supplier
 * fixtures with the prices and dates the search shows right now; the status is «Заказан у
 * поставщика» with the three events that lead there, worded by the real timeline.
 *
 * Nothing here is a client's data: no phone, no name, no requisites, and no buttons (every
 * client action is off, the order API does not exist in the demo).
 */
import {
  buildOfferViews,
  formatPromise,
  safeMul,
  sumKop,
  type IsoDate,
  type OfferView,
} from '@detaly/domain';
import type { RosskoClient } from '@detaly/rossko';
import type { OrderItemView, OrderView } from '../orders/order-view';
import { orderStatusLabel, orderStatusTone } from '../orders/status-labels';
import { buildTimeline, type TimelineEvent } from '../orders/timeline';
import type { SearchSettings } from '../settings';

/** Fixture articles of the two positions: an oil filter and brake pads. */
export const DEMO_ORDER_ARTICLES = ['OC90', 'GDB1330'] as const;

/** The access token of the sample order (real tokens are 16+ characters, never this). */
export const DEMO_ORDER_TOKEN = 'demo';

export const DEMO_ORDER_NUMBER = 'DT-000042';

const ORDER_ID = 'd0000000-0000-4000-8000-00000000a001';
const ITEM_IDS = ['d0000000-0000-4000-8000-00000000b001', 'd0000000-0000-4000-8000-00000000b002'];

const HOUR_MS = 3_600_000;

export interface DemoOrderDeps {
  rossko: Pick<RosskoClient, 'search'>;
  loadSettings: () => Promise<Pick<SearchSettings, 'markupRules' | 'excludedRules' | 'eta'>>;
  now?: Date;
}

/** The offer a client would most likely pick: the requested article, sellable, cheapest. */
function pickView(views: readonly OfferView[]): OfferView | null {
  return (
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
      stateLabel: 'Заказана, едет к нам',
      waiting: true,
      inactive: false,
      canCancel: false,
    };
  });
  const promisedDate = picked
    .map((view) => view.etaDate)
    .sort()
    .at(-1) as IsoDate;
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
