// Data of order notification templates (docs/phase-1b-implementation.md section 12.1): the
// order number, scheme, brand + article of the items, sum, dates, /o/<token> and admin links,
// the pickup point from env. Client templates never get the phone (PD minimisation, PLAN
// section 4); staff templates get it and print it masked. Phase 1C adds the installation
// partner, the packaging photo of `arrived`, the slot of install_* and the claim of claim_*
// (addPhase1cData) — never the client's claim text or the master's decision text.
import { reviewPlatforms, type Env } from '@detaly/config';
import {
  and,
  asc,
  claims,
  clientApprovals,
  desc,
  eq,
  inArray,
  installBookings,
  isNull,
  orderItems,
  orderPhotos,
  orders,
  payments,
  refunds,
  sql,
  supplierOrders,
  users,
  type Executor,
} from '@detaly/db';
import {
  DROPPED_ORDER_ITEM_STATES,
  INSTALL_HOLDING_STATUSES,
  installSlotOf,
  isIsoDate,
  localDate,
  type ApprovalProposal,
  type IsoDate,
  type NotifyAudience,
  type OrderItemState,
  type OrderNotifyTemplate,
} from '@detaly/domain';
import { promise, type OrderTemplateData, type PickupPoint } from '@detaly/notify';
import { isUuid, type OrderSettings } from '@detaly/orders';

const HOUR_MS = 3_600_000;

/** Extra values a job may carry (reminders, alerts); none of them is PD. */
export interface TemplateExtras {
  /** Days since the order became ready (reminders 3/6/9). */
  readyDays?: number | null;
  /** Deadline shown to staff. */
  deadlineDate?: IsoDate | null;
  /** Staff note without PD. */
  note?: string | null;
}

export type OrderRow = typeof orders.$inferSelect;

export interface LoadedTemplateData {
  order: OrderRow;
  data: OrderTemplateData;
}

/** APP_BASE_URL without a trailing slash. */
export function baseUrl(env: Pick<Env, 'APP_BASE_URL'>): string {
  return env.APP_BASE_URL.replace(/\/+$/, '');
}

export function orderUrl(env: Pick<Env, 'APP_BASE_URL'>, accessToken: string): string {
  return `${baseUrl(env)}/o/${accessToken}`;
}

export function adminUrl(env: Pick<Env, 'APP_BASE_URL'>, orderId: string): string {
  return `${baseUrl(env)}/admin/orders/${orderId}`;
}

/** PICKUP_* from env; null until the address is configured. The point's phone is not sent. */
export function pickupPoint(env: Env): PickupPoint | null {
  if (!env.PICKUP_ADDRESS) return null;
  return {
    name: env.PICKUP_POINT_NAME ?? env.BRAND_NAME,
    address: env.PICKUP_ADDRESS,
    hours: env.PICKUP_HOURS ?? '',
  };
}

function windowDays(scheme: OrderRow['paymentScheme'], settings: OrderSettings): number {
  return scheme === 'prepay' ? settings.pickupWindowPrepaidDays : settings.pickupWindowCodDays;
}

const DROPPED: readonly OrderItemState[] = DROPPED_ORDER_ITEM_STATES;

/** A short text of what the client is asked about (brand and article only). */
export function proposalNote(proposal: ApprovalProposal | null | undefined): string | null {
  if (!proposal) return null;
  if (proposal.kind === 'new_eta') return `Новый срок: ${promise(proposal.etaDate)}.`;
  return `Предлагаем замену: ${proposal.offer.brand} ${proposal.offer.article}, цена та же.`;
}

/**
 * Loads the order and builds OrderTemplateData for `template`. `sendAt` is the moment of
 * sending: decision_needed without a running timer promises `sendAt + approval.timeout_h`
 * (the notify job starts the timer with the same instant).
 */
export async function loadTemplateData(
  db: Executor,
  input: {
    env: Env;
    settings: OrderSettings;
    orderId: string;
    audience: NotifyAudience;
    template: OrderNotifyTemplate;
    /** payments.id from the event payload (amount of the payment the event is about). */
    paymentId?: string | null;
    extras?: TemplateExtras;
    /**
     * Payload of the order event the job hangs on: `claimId` / `bookingId` (phase 1C journal
     * events and reminders) pick the claim or the booking a message is about.
     */
    eventPayload?: Record<string, unknown> | null;
    sendAt: Date;
  },
): Promise<LoadedTemplateData | null> {
  const { env, settings, orderId, audience, template, extras = {}, sendAt } = input;
  const eventPayload = input.eventPayload ?? {};
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;

  const items = await db
    .select({ brand: orderItems.brand, article: orderItems.article, state: orderItems.state })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  const live = items.filter((item) => !DROPPED.includes(item.state));
  // A refunded or cancelled order has no live items: show what was ordered (not replaced ones).
  const shown = live.length > 0 ? live : items.filter((item) => item.state !== 'replaced');

  const paymentRows = await db
    .select({ id: payments.id, status: payments.status, amountKop: payments.amountKop })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(desc(payments.createdAt), desc(payments.id));
  const eventPayment = input.paymentId
    ? paymentRows.find((p) => p.id === input.paymentId)
    : undefined;
  const paid = eventPayment ?? paymentRows.find((p) => p.status === 'succeeded') ?? paymentRows[0];

  const data: OrderTemplateData = {
    brandName: env.BRAND_NAME,
    orderId: order.id,
    orderNumber: order.number,
    orderUrl: orderUrl(env, order.accessToken),
    scheme: order.paymentScheme,
    items: shown.map((item) => ({ brand: item.brand, article: item.article })),
    promisedDate: order.promisedDate,
    totalKop: order.totalKop,
    paidAmountKop: paid?.amountKop ?? null,
    pickup: pickupPoint(env),
    pickupCode: order.pickupCode,
    note: extras.note ?? null,
    readyDays: extras.readyDays ?? null,
    deadlineDate: extras.deadlineDate ?? null,
    storageDays: windowDays(order.paymentScheme, settings),
  };

  if (audience !== 'client') {
    // Staff templates print it masked (•••4567); the client never gets it.
    const [user] = await db
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, order.userId));
    data.clientPhone = user?.phone.startsWith('+') ? user.phone : null;
    data.adminUrl = adminUrl(env, order.id);
  }

  if (template === 'confirm_request') {
    data.replyBy =
      order.expiresAt ??
      new Date(order.createdAt.getTime() + settings.onPickupConfirmTtlH * HOUR_MS);
  } else if (template === 'decision_needed') {
    const [approval] = await db
      .select({ expiresAt: clientApprovals.expiresAt, proposal: clientApprovals.proposal })
      .from(clientApprovals)
      .where(and(eq(clientApprovals.orderId, orderId), isNull(clientApprovals.decidedAt)))
      .limit(1);
    data.replyBy =
      approval?.expiresAt ?? new Date(sendAt.getTime() + settings.approvalTimeoutH * HOUR_MS);
    data.note ??= proposalNote(approval?.proposal);
  } else if (template === 'staff_supplier_invoice_due') {
    const [invoice] = await db
      .select({ number: supplierOrders.invoiceNumber, amountKop: supplierOrders.invoiceAmountKop })
      .from(supplierOrders)
      .where(
        and(
          eq(supplierOrders.orderId, orderId),
          eq(supplierOrders.status, 'created'),
          isNull(supplierOrders.invoicePaidAt),
        ),
      )
      .orderBy(desc(supplierOrders.attemptNo))
      .limit(1);
    if (invoice?.number && invoice.amountKop !== null) {
      data.supplierInvoice = { number: invoice.number, amountKop: invoice.amountKop };
    }
  } else if (template === 'staff_supplier_return_task') {
    if (!data.deadlineDate && order.supplierReturnDeadlineAt) {
      data.deadlineDate = localDate(order.supplierReturnDeadlineAt);
    }
  } else if (template === 'staff_refund_deadline' && !data.deadlineDate) {
    const [refund] = await db
      .select({ deadlineAt: refunds.deadlineAt })
      .from(refunds)
      .where(and(eq(refunds.orderId, orderId), inArray(refunds.status, ['pending', 'failed'])))
      .orderBy(asc(refunds.deadlineAt))
      .limit(1);
    if (refund) data.deadlineDate = localDate(refund.deadlineAt);
  }
  await addPhase1cData(db, { env, order, template, eventPayload, data });
  if (REVIEW_TEMPLATES.includes(template)) {
    // Step 3 (docs/reviews.md): the platforms with a review link; the template builds the
    // buttons to our redirect under the order page from them.
    data.reviewPlatforms = reviewPlatforms(env);
  }
  if (data.deadlineDate && !isIsoDate(data.deadlineDate)) data.deadlineDate = null;
  return { order, data };
}

/** Templates with the review buttons (step 3): «Как деталь?» and the one reminder. */
const REVIEW_TEMPLATES: readonly OrderNotifyTemplate[] = ['how_is_it', 'review_reminder'];

const CLAIM_TEMPLATES: readonly OrderNotifyTemplate[] = [
  'claim_received',
  'claim_decided',
  'claim_refund_started',
  'staff_claim_opened',
  'staff_claim_deadline',
];
const INSTALL_TEMPLATES: readonly OrderNotifyTemplate[] = [
  'arrived',
  'install_requested',
  'install_confirmed',
  'install_declined',
  'install_reminder',
  'staff_install_request',
];

/** A uuid from the event payload: `key` itself or `<object>.id` (e.g. payload.claim.id). */
function payloadId(payload: Record<string, unknown>, key: string, object: string): string | null {
  if (isUuid(payload[key])) return payload[key];
  const nested = payload[object];
  if (typeof nested === 'object' && nested !== null) {
    const id = (nested as Record<string, unknown>).id;
    if (isUuid(id)) return id;
  }
  return null;
}

/** 'чт 8 окт 14:00' of a slot in the client time zone. */
export function slotText(slotAt: Date): string {
  const slot = installSlotOf({ slotStart: slotAt, carReadyAt: slotAt });
  return `${slot.dayText} ${slot.timeText}`;
}

/**
 * Phase 1C data (docs/phase-1c-implementation.md section 7.2 item 2): the installation partner,
 * the packaging photo of `arrived` (one key, never claim or return photos), the slot of install_*,
 * the claim (kind, decision, answer deadline) of claim_* — without the client's or the master's
 * texts (decision С2).
 */
async function addPhase1cData(
  db: Executor,
  input: {
    env: Env;
    order: OrderRow;
    template: OrderNotifyTemplate;
    eventPayload: Record<string, unknown>;
    data: OrderTemplateData;
  },
): Promise<void> {
  const { env, order, template, eventPayload, data } = input;
  if (INSTALL_TEMPLATES.includes(template)) {
    data.installPartner = env.INSTALL_PARTNER_NAME ?? null;
    data.installPartnerRequisites = env.INSTALL_PARTNER_REQUISITES ?? null;
  }

  if (template === 'arrived') {
    // Already booked (a reminder on day 3/6/9): no second «Записаться на установку».
    const [active] = await db
      .select({ id: installBookings.id })
      .from(installBookings)
      .where(
        and(
          eq(installBookings.orderId, order.id),
          inArray(installBookings.status, [...INSTALL_HOLDING_STATUSES]),
        ),
      )
      .limit(1);
    if (active) data.installPartner = null;
    const photos = await db
      .select({ key: orderPhotos.s3Key })
      .from(orderPhotos)
      .where(and(eq(orderPhotos.orderId, order.id), eq(orderPhotos.kind, 'packaging')))
      .orderBy(desc(orderPhotos.createdAt), desc(orderPhotos.id))
      .limit(1);
    data.photos = photos.map((photo) => photo.key);
  }

  if (INSTALL_TEMPLATES.includes(template) && template !== 'arrived') {
    const bookingId = payloadId(eventPayload, 'bookingId', 'booking');
    const [booking] = await db
      .select({ slotAt: installBookings.slotAt })
      .from(installBookings)
      .where(
        bookingId === null
          ? eq(installBookings.orderId, order.id)
          : and(eq(installBookings.orderId, order.id), eq(installBookings.id, bookingId)),
      )
      .orderBy(desc(installBookings.createdAt), desc(installBookings.id))
      .limit(1);
    data.slotText = booking ? slotText(booking.slotAt) : null;
  }

  if (CLAIM_TEMPLATES.includes(template)) {
    const claimId = payloadId(eventPayload, 'claimId', 'claim');
    const [claim] = await db
      .select({
        kind: claims.kind,
        decision: claims.decision,
        deadlineAt: claims.deadlineAt,
        orderItemId: claims.orderItemId,
      })
      .from(claims)
      .where(
        claimId === null
          ? eq(claims.orderId, order.id)
          : and(eq(claims.orderId, order.id), eq(claims.id, claimId)),
      )
      // Without an id: the latest decided claim for claim_decided, the latest opened otherwise.
      .orderBy(
        ...(template === 'claim_decided' ? [sql`${claims.decidedAt} desc nulls last`] : []),
        desc(claims.openedAt),
        desc(claims.id),
      )
      .limit(1);
    if (claim) {
      const deadlineDate = localDate(claim.deadlineAt);
      data.claim = { kind: claim.kind, decision: claim.decision, deadlineDate };
      if (template === 'staff_claim_deadline' || template === 'staff_claim_opened') {
        data.deadlineDate ??= deadlineDate;
      }
      if (template === 'claim_refund_started' && claim.orderItemId !== null) {
        // The refunded item itself, not the rest of the order that stays with the client.
        const [item] = await db
          .select({ brand: orderItems.brand, article: orderItems.article })
          .from(orderItems)
          .where(and(eq(orderItems.orderId, order.id), eq(orderItems.id, claim.orderItemId)));
        if (item) data.items = [item];
      }
    } else {
      data.claim = null;
    }
  }
}
