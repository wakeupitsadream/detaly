/**
 * loadOrderSnapshot: the order row (`select … for update` with `lock`) and everything a
 * transition decision reads. The client phone is never loaded here: receipts that need it read
 * it separately (loadClientPhone) and only into the provider request stored in the database.
 */
import {
  and,
  asc,
  claims,
  clientApprovals,
  eq,
  inArray,
  installBookings,
  isNull,
  orderItems,
  orders,
  payments,
  receipts,
  refunds,
  supplierOrderItems,
  supplierOrders,
  users,
} from '@detaly/db';
import type { OrderSnapshot, SupplierOrderView, Tx } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids from the bot, the admin and job data are checked before they reach SQL (22P02). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Loads the order (`for update` with lock) and everything the decision needs. */
export async function loadOrderSnapshot(
  tx: Tx,
  orderId: string,
  options: { lock: boolean },
): Promise<OrderSnapshot | null> {
  if (!isUuid(orderId)) return null;
  const query = tx.select().from(orders).where(eq(orders.id, orderId));
  const [order] = options.lock ? await query.for('update') : await query;
  if (!order) return null;

  const [
    items,
    paymentRows,
    receiptRows,
    refundRows,
    supplierRows,
    approvals,
    userRows,
    claimRows,
    bookingRows,
  ] = await Promise.all([
    tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.createdAt), asc(orderItems.id)),
    tx
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .orderBy(asc(payments.createdAt), asc(payments.id)),
    tx
      .select()
      .from(receipts)
      .where(eq(receipts.orderId, orderId))
      .orderBy(asc(receipts.createdAt), asc(receipts.id)),
    tx
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, orderId))
      .orderBy(asc(refunds.createdAt), asc(refunds.id)),
    tx
      .select()
      .from(supplierOrders)
      .where(eq(supplierOrders.orderId, orderId))
      .orderBy(asc(supplierOrders.attemptNo)),
    tx
      .select()
      .from(clientApprovals)
      .where(and(eq(clientApprovals.orderId, orderId), isNull(clientApprovals.decidedAt)))
      .limit(1),
    tx.select({ noShowCount: users.noShowCount }).from(users).where(eq(users.id, order.userId)),
    // Claims without their texts (they may hold PD): the engine needs only the facts.
    tx
      .select({
        id: claims.id,
        orderItemId: claims.orderItemId,
        kind: claims.kind,
        openedAt: claims.openedAt,
        deadlineAt: claims.deadlineAt,
        decision: claims.decision,
        decidedAt: claims.decidedAt,
        returnAcceptedAt: claims.returnAcceptedAt,
        compensationAmountKop: claims.compensationAmountKop,
        refundId: claims.refundId,
        closedAt: claims.closedAt,
        replacementOrderedAt: claims.replacementOrderedAt,
        photos: claims.photos,
      })
      .from(claims)
      .where(eq(claims.orderId, orderId))
      .orderBy(asc(claims.openedAt), asc(claims.id)),
    tx
      .select({
        id: installBookings.id,
        slotAt: installBookings.slotAt,
        status: installBookings.status,
        createdVia: installBookings.createdVia,
        confirmedAt: installBookings.confirmedAt,
        cancelledAt: installBookings.cancelledAt,
      })
      .from(installBookings)
      .where(eq(installBookings.orderId, orderId))
      .orderBy(asc(installBookings.createdAt), asc(installBookings.id)),
  ]);

  const links =
    supplierRows.length === 0
      ? []
      : await tx
          .select()
          .from(supplierOrderItems)
          .where(
            inArray(
              supplierOrderItems.supplierOrderId,
              supplierRows.map((row) => row.id),
            ),
          );
  const supplierViews: SupplierOrderView[] = supplierRows.map((row) => ({
    ...row,
    itemIds: links.filter((l) => l.supplierOrderId === row.id).map((l) => l.orderItemId),
  }));

  return {
    order,
    items,
    payments: paymentRows,
    receipts: receiptRows,
    refunds: refundRows,
    supplierOrders: supplierViews,
    openApproval: approvals[0] ?? null,
    noShowCount: userRows[0]?.noShowCount ?? 0,
    claims: claimRows.map(({ photos, ...claim }) => ({
      ...claim,
      photoCount: Array.isArray(photos) ? photos.length : 0,
    })),
    bookings: bookingRows,
  };
}

/**
 * The client phone (E.164) for a receipt's customer.phone. Returns null for an anonymized or
 * malformed phone. Never log the result.
 */
export async function loadClientPhone(tx: Tx, userId: string): Promise<string | null> {
  const [row] = await tx.select({ phone: users.phone }).from(users).where(eq(users.id, userId));
  const phone = row?.phone ?? null;
  return phone !== null && /^\+\d{10,15}$/.test(phone) ? phone : null;
}
