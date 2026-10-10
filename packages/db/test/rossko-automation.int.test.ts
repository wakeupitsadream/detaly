// Step 8 (docs/rossko-automation.md, migration 0011): what the GetOrders polling stores per supplier
// order — the latest code, name and when it was checked and changed, and one entry per Rossko
// order of the attempt in rossko_statuses (an object, {} by default).
import { testDatabaseUrl } from '@detaly/config/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client';
import { supplierOrders } from '../src/schema';
import { expectPgError, insertOrder } from './helpers';

const CHECK = '23514';

let db: Db;

beforeAll(() => {
  db = createDb(testDatabaseUrl(), { max: 4 });
});

afterAll(async () => {
  await db?.close();
});

describe('supplier_orders polling columns (0011)', () => {
  it('a new attempt has no status yet and an empty map of Rossko orders', async () => {
    const order = await insertOrder(db);
    const [row] = await db
      .insert(supplierOrders)
      .values({ orderId: order.id, attemptNo: 1, status: 'created', rosskoOrderIds: ['70000010'] })
      .returning();
    expect(row).toMatchObject({
      statusCode: null,
      statusName: null,
      statusCheckedAt: null,
      statusChangedAt: null,
      rosskoStatuses: {},
    });

    const at = new Date('2026-10-12T05:00:00.000Z');
    const [updated] = await db
      .update(supplierOrders)
      .set({
        statusCode: 3,
        statusName: 'Отгружен',
        statusCheckedAt: at,
        statusChangedAt: at,
        rosskoStatuses: {
          '70000010': { code: 3, name: 'Отгружен', changedAt: at.toISOString(), handled: true },
        },
      })
      .where(eq(supplierOrders.id, row!.id))
      .returning();
    expect(updated?.rosskoStatuses['70000010']).toEqual({
      code: 3,
      name: 'Отгружен',
      changedAt: at.toISOString(),
      handled: true,
    });
    expect(updated?.statusCheckedAt).toEqual(at);
  });

  it('rossko_statuses is always an object', async () => {
    const order = await insertOrder(db);
    const [row] = await db
      .insert(supplierOrders)
      .values({ orderId: order.id, attemptNo: 1 })
      .returning({ id: supplierOrders.id });
    await expectPgError(
      db
        .update(supplierOrders)
        .set({ rosskoStatuses: sql`'[]'::jsonb` })
        .where(eq(supplierOrders.id, row!.id)),
      CHECK,
      'supplier_orders_rossko_statuses_check',
    );
    await expectPgError(
      db
        .update(supplierOrders)
        .set({ rosskoStatuses: sql`'"x"'::jsonb` })
        .where(eq(supplierOrders.id, row!.id)),
      CHECK,
      'supplier_orders_rossko_statuses_check',
    );
  });
});
