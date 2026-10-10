// Step 7 (docs/month-close.md): supplier returns to the end and the reconciliation snapshots
// (migration 0010): «Сдал водителю» needs shipped_at, «Деньги вернулись» needs refunded_at and the
// amount, a snapshot names a month and its author.
import { testDatabaseUrl } from '@detaly/config/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client';
import { financeReconciliations, orderItems, supplierReturns } from '../src/schema';
import { expectPgError, insertOrder, SAMPLE_OFFER } from './helpers';

const CHECK = '23514';

let db: Db;

beforeAll(() => {
  db = createDb(testDatabaseUrl(), { max: 4 });
});

afterAll(async () => {
  await db?.close();
});

async function insertReturn() {
  const order = await insertOrder(db);
  const [item] = await db
    .insert(orderItems)
    .values({
      orderId: order.id,
      offerKey: 'W9142:MANN:ORB1',
      searchArticleNorm: 'W9142',
      brand: 'MANN',
      article: 'W 914/2',
      name: 'Фильтр масляный',
      qty: 1,
      stockId: 'ORB1',
      isLocal: true,
      priceSupplierAtOrderKop: 50_000,
      priceClientKop: 64_000,
      markupBp: 2800,
      offerSnapshot: SAMPLE_OFFER,
    })
    .returning();
  const [ret] = await db
    .insert(supplierReturns)
    .values({ orderItemId: item!.id, kind: 'return', amountExpectedKop: 50_000 })
    .returning();
  return ret!;
}

describe('supplier_returns (0010)', () => {
  it('shipped needs shipped_at; refunded needs refunded_at and the amount received', async () => {
    const ret = await insertReturn();
    expect(ret.status).toBe('requested');
    expect(ret.shippedAt).toBeNull();
    await expectPgError(
      db.update(supplierReturns).set({ status: 'shipped' }).where(eq(supplierReturns.id, ret.id)),
      CHECK,
      'supplier_returns_shipped_check',
    );
    const shippedAt = new Date('2026-10-05T07:00:00.000Z');
    await db
      .update(supplierReturns)
      .set({ status: 'shipped', shippedAt })
      .where(eq(supplierReturns.id, ret.id));
    await expectPgError(
      db
        .update(supplierReturns)
        .set({ status: 'refunded', refundedAt: new Date() })
        .where(eq(supplierReturns.id, ret.id)),
      CHECK,
      'supplier_returns_refunded_check',
    );
    await expectPgError(
      db
        .update(supplierReturns)
        .set({ status: 'refunded', amountReceivedKop: 50_000 })
        .where(eq(supplierReturns.id, ret.id)),
      CHECK,
      'supplier_returns_refunded_check',
    );
    const refundedAt = new Date('2026-10-12T07:00:00.000Z');
    await db
      .update(supplierReturns)
      .set({ status: 'refunded', amountReceivedKop: 49_000, refundedAt })
      .where(eq(supplierReturns.id, ret.id));
    const [stored] = await db.select().from(supplierReturns).where(eq(supplierReturns.id, ret.id));
    expect(stored).toMatchObject({
      status: 'refunded',
      shippedAt,
      refundedAt,
      amountReceivedKop: 49_000,
    });
  });

  it('a negative amount received is refused as before', async () => {
    const ret = await insertReturn();
    await expectPgError(
      db
        .update(supplierReturns)
        .set({ amountReceivedKop: -1 })
        .where(eq(supplierReturns.id, ret.id)),
      CHECK,
      'supplier_returns_amount_received_kop_check',
    );
  });
});

describe('finance_reconciliations (0010)', () => {
  it('stores a snapshot of a month by its author; refuses a bad month or an empty author', async () => {
    const [row] = await db
      .insert(financeReconciliations)
      .values({ month: '2026-09', createdBy: 'admin', result: { differences: [] } })
      .returning();
    expect(row).toMatchObject({ month: '2026-09', createdBy: 'admin' });
    expect(row?.createdAt).toBeInstanceOf(Date);
    for (const month of ['2026-13', '2026-9', '1999-12', '2026-09-01']) {
      await expectPgError(
        db.insert(financeReconciliations).values({ month, createdBy: 'admin', result: {} }),
        CHECK,
        'finance_reconciliations_month_check',
      );
    }
    await expectPgError(
      db.insert(financeReconciliations).values({ month: '2026-09', createdBy: ' ', result: {} }),
      CHECK,
      'finance_reconciliations_created_by_check',
    );
  });
});
