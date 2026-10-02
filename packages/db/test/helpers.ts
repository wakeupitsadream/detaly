import { randomBytes, randomInt } from 'node:crypto';
import type { Offer } from '@detaly/domain/types';
import { expect } from 'vitest';
import type { Database } from '../src/client';
import { orders, users } from '../src/schema';

/** SQLSTATE of a postgres error, possibly wrapped by drizzle (DrizzleQueryError.cause). */
export function pgErrorOf(error: unknown): { code?: string; constraint_name?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      return current as { code?: string; constraint_name?: string };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Asserts the promise rejects with the given SQLSTATE (and constraint name when given). */
export async function expectPgError(
  promise: Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected SQLSTATE ${code}`).toBeDefined();
  const pg = pgErrorOf(caught);
  expect(pg?.code).toBe(code);
  if (constraint) expect(pg?.constraint_name).toBe(constraint);
}

export function randomPhone(): string {
  return `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

export function randomToken(): string {
  return randomBytes(18).toString('base64url');
}

export async function insertUser(db: Database, phone = randomPhone()) {
  const [user] = await db.insert(users).values({ phone }).returning();
  if (!user) throw new Error('user not inserted');
  return user;
}

export async function insertOrder(db: Database, values: Partial<typeof orders.$inferInsert> = {}) {
  const userId = values.userId ?? (await insertUser(db)).id;
  const [order] = await db
    .insert(orders)
    .values({
      userId,
      accessToken: randomToken(),
      paymentScheme: 'prepay',
      subtotalKop: 128_000,
      courierFeeKop: 0,
      totalKop: 128_000,
      itemsHash: 'test',
      ...values,
    })
    .returning();
  if (!order) throw new Error('order not inserted');
  return order;
}

export const SAMPLE_OFFER: Offer = {
  source: 'rossko',
  brand: 'MANN',
  article: 'W 914/2',
  articleNorm: 'W9142',
  name: 'Фильтр масляный',
  group: null,
  isCross: false,
  priceSupplierKop: 100_000,
  stock: {
    stockId: 'ORB1',
    isLocal: true,
    count: 4,
    multiplicity: 1,
    type: null,
    deliveryDays: 0,
    deliveryStart: null,
    deliveryEnd: null,
    extra: null,
    description: null,
  },
};
