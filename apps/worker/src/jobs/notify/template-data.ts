// Data of order notification templates (docs/phase-1b-implementation.md section 12.1): the
// order number, scheme, brand + article of the items, sum, dates, /o/<token> and admin links,
// the pickup point from env. Client templates never get the phone (PD minimisation, PLAN
// section 4); staff templates get it and print it masked.
import type { Env } from '@detaly/config';
import {
  and,
  asc,
  clientApprovals,
  desc,
  eq,
  inArray,
  isNull,
  orderItems,
  orders,
  payments,
  refunds,
  supplierOrders,
  users,
  type Executor,
} from '@detaly/db';
import {
  DROPPED_ORDER_ITEM_STATES,
  isIsoDate,
  localDate,
  type ApprovalProposal,
  type IsoDate,
  type NotifyAudience,
  type OrderItemState,
  type OrderNotifyTemplate,
} from '@detaly/domain';
import { promise, type OrderTemplateData, type PickupPoint } from '@detaly/notify';
import type { OrderSettings } from '@detaly/orders';

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
    sendAt: Date;
  },
): Promise<LoadedTemplateData | null> {
  const { env, settings, orderId, audience, template, extras = {}, sendAt } = input;
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
  if (data.deadlineDate && !isIsoDate(data.deadlineDate)) data.deadlineDate = null;
  return { order, data };
}
