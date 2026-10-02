// Relations for the relational query API (`db.query.<table>.findFirst({ with: ... })`).
// They describe existing foreign keys only and do not affect SQL or migrations.
import { relations } from 'drizzle-orm';
import { cartItems, carts } from './carts';
import { orderEvents, orderItems, orders } from './orders';
import { payments, receipts, refunds } from './payments';
import { consents, documentVersions, users } from './people';
import { supplierOrderItems, supplierOrders } from './supplier';
import { notifications } from './system';
import { clientApprovals, sellerCards } from './workflow';

export const cartsRelations = relations(carts, ({ many, one }) => ({
  items: many(cartItems),
  user: one(users, { fields: [carts.userId], references: [users.id] }),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  cart: one(carts, { fields: [cartItems.cartId], references: [carts.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
  consents: many(consents),
}));

export const ordersRelations = relations(orders, ({ many, one }) => ({
  user: one(users, { fields: [orders.userId], references: [users.id] }),
  items: many(orderItems),
  events: many(orderEvents),
  payments: many(payments),
  receipts: many(receipts),
  refunds: many(refunds),
  supplierOrders: many(supplierOrders),
  approvals: many(clientApprovals),
  sellerCards: many(sellerCards),
  consents: many(consents),
  offerVersion: one(documentVersions, {
    fields: [orders.offerVersionId],
    references: [documentVersions.id],
  }),
}));

export const orderItemsRelations = relations(orderItems, ({ many, one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  supplierOrderItems: many(supplierOrderItems),
}));

export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, { fields: [orderEvents.orderId], references: [orders.id] }),
}));

export const consentsRelations = relations(consents, ({ one }) => ({
  user: one(users, { fields: [consents.userId], references: [users.id] }),
  order: one(orders, { fields: [consents.orderId], references: [orders.id] }),
  documentVersion: one(documentVersions, {
    fields: [consents.documentVersionId],
    references: [documentVersions.id],
  }),
}));

export const paymentsRelations = relations(payments, ({ many, one }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
  receipts: many(receipts),
  refunds: many(refunds),
}));

export const receiptsRelations = relations(receipts, ({ one }) => ({
  order: one(orders, { fields: [receipts.orderId], references: [orders.id] }),
  payment: one(payments, { fields: [receipts.paymentId], references: [payments.id] }),
  refund: one(refunds, { fields: [receipts.refundId], references: [refunds.id] }),
}));

export const refundsRelations = relations(refunds, ({ many, one }) => ({
  order: one(orders, { fields: [refunds.orderId], references: [orders.id] }),
  payment: one(payments, { fields: [refunds.paymentId], references: [payments.id] }),
  receipts: many(receipts),
}));

export const supplierOrdersRelations = relations(supplierOrders, ({ many, one }) => ({
  order: one(orders, { fields: [supplierOrders.orderId], references: [orders.id] }),
  /** Order items of this attempt, through supplier_order_items. */
  items: many(supplierOrderItems),
}));

export const supplierOrderItemsRelations = relations(supplierOrderItems, ({ one }) => ({
  supplierOrder: one(supplierOrders, {
    fields: [supplierOrderItems.supplierOrderId],
    references: [supplierOrders.id],
  }),
  orderItem: one(orderItems, {
    fields: [supplierOrderItems.orderItemId],
    references: [orderItems.id],
  }),
}));

export const clientApprovalsRelations = relations(clientApprovals, ({ one }) => ({
  order: one(orders, { fields: [clientApprovals.orderId], references: [orders.id] }),
  item: one(orderItems, { fields: [clientApprovals.orderItemId], references: [orderItems.id] }),
}));

export const sellerCardsRelations = relations(sellerCards, ({ one }) => ({
  order: one(orders, { fields: [sellerCards.orderId], references: [orders.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  order: one(orders, { fields: [notifications.orderId], references: [orders.id] }),
}));
