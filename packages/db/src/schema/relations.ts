// Relations for the relational query API (`db.query.<table>.findFirst({ with: ... })`).
// They describe existing foreign keys only and do not affect SQL or migrations.
import { relations } from 'drizzle-orm';
import { cartItems, carts, vinRequests } from './carts';
import { linkTokens, orderEvents, orderItems, orders } from './orders';
import { payments, receipts, refunds } from './payments';
import { consents, documentVersions, messengerBindings, users } from './people';
import { claims, installBookings, orderPhotos } from './service';
import { supplierOrderItems, supplierOrders } from './supplier';
import { notifications } from './system';
import { userVehicles } from './vehicles';
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
  messengerBindings: many(messengerBindings),
  vinRequests: many(vinRequests),
  // step 6 (docs/garage.md)
  vehicles: many(userVehicles),
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
  // phase 1C
  claims: many(claims),
  installBookings: many(installBookings),
  photos: many(orderPhotos),
  vinRequest: one(vinRequests, { fields: [orders.vinRequestId], references: [vinRequests.id] }),
  // step 6 (docs/garage.md)
  vehicle: one(userVehicles, { fields: [orders.vehicleId], references: [userVehicles.id] }),
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
  vinRequest: one(vinRequests, {
    fields: [sellerCards.vinRequestId],
    references: [vinRequests.id],
  }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  order: one(orders, { fields: [notifications.orderId], references: [orders.id] }),
  vinRequest: one(vinRequests, {
    fields: [notifications.vinRequestId],
    references: [vinRequests.id],
  }),
}));

// --- phase 1C (docs/phase-1c-implementation.md section 1.1) -----------------------------------

export const claimsRelations = relations(claims, ({ many, one }) => ({
  order: one(orders, { fields: [claims.orderId], references: [orders.id] }),
  item: one(orderItems, { fields: [claims.orderItemId], references: [orderItems.id] }),
  photos: many(orderPhotos),
  refund: one(refunds, { fields: [claims.refundId], references: [refunds.id] }),
}));

export const installBookingsRelations = relations(installBookings, ({ one }) => ({
  order: one(orders, { fields: [installBookings.orderId], references: [orders.id] }),
  user: one(users, { fields: [installBookings.userId], references: [users.id] }),
}));

export const orderPhotosRelations = relations(orderPhotos, ({ one }) => ({
  order: one(orders, { fields: [orderPhotos.orderId], references: [orders.id] }),
  claim: one(claims, { fields: [orderPhotos.claimId], references: [claims.id] }),
  item: one(orderItems, { fields: [orderPhotos.orderItemId], references: [orderItems.id] }),
}));

export const vinRequestsRelations = relations(vinRequests, ({ many, one }) => ({
  user: one(users, { fields: [vinRequests.userId], references: [users.id] }),
  proposalCart: one(carts, { fields: [vinRequests.proposalCartId], references: [carts.id] }),
  orders: many(orders),
  sellerCards: many(sellerCards),
}));

export const linkTokensRelations = relations(linkTokens, ({ one }) => ({
  user: one(users, { fields: [linkTokens.userId], references: [users.id] }),
  order: one(orders, { fields: [linkTokens.orderId], references: [orders.id] }),
}));

export const messengerBindingsRelations = relations(messengerBindings, ({ one }) => ({
  user: one(users, { fields: [messengerBindings.userId], references: [users.id] }),
}));

// --- step 6 (docs/garage.md) ------------------------------------------------------------------

export const userVehiclesRelations = relations(userVehicles, ({ many, one }) => ({
  user: one(users, { fields: [userVehicles.userId], references: [users.id] }),
  orders: many(orders),
}));
