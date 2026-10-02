// Relations for the relational query API (`db.query.<table>.findFirst({ with: ... })`).
// They describe existing foreign keys only and do not affect SQL or migrations.
import { relations } from 'drizzle-orm';
import { cartItems, carts } from './carts';
import { orderEvents, orderItems, orders } from './orders';
import { payments } from './payments';
import { consents, documentVersions, users } from './people';

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
  consents: many(consents),
  offerVersion: one(documentVersions, {
    fields: [orders.offerVersionId],
    references: [documentVersions.id],
  }),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
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

export const paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
}));
