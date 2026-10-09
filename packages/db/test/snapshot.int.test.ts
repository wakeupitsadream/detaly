// readSnapshot (src/snapshot.ts): one REPEATABLE READ, READ ONLY transaction for a read model
// of several queries. A commit from another connection between two of its reads is invisible to
// the second one (the order page's race of a payment applied between the order and its
// payments), it refuses writes, and inside a transaction it joins the caller's.
import { testDatabaseUrl } from '@detaly/config/testing';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client';
import { kits } from '../src/schema';
import { READ_SNAPSHOT, readSnapshot } from '../src/snapshot';
import { expectPgError } from './helpers';

const READ_ONLY_TRANSACTION = '25006';

let db: Db;

beforeAll(() => {
  db = createDb(testDatabaseUrl(), { max: 4 });
});

afterAll(async () => {
  await db?.close();
});

/** A draft kit of a model of its own: nothing else in the database counts it. */
function insertKit(modelSlug: string, engine: string) {
  return db.insert(kits).values({
    makeSlug: 'lada',
    model: 'Vesta',
    modelSlug,
    engine,
    yearsFrom: 2015,
    slug: `s-${uuidv7().slice(-12)}`,
    createdBy: 'test',
    updatedBy: 'test',
  });
}

async function enginesOf(executor: Pick<Db, 'select'>, modelSlug: string): Promise<string[]> {
  const rows = await executor
    .select({ engine: kits.engine })
    .from(kits)
    .where(eq(kits.modelSlug, modelSlug));
  return rows.map((row) => row.engine).sort();
}

describe('readSnapshot', () => {
  it('is REPEATABLE READ and READ ONLY', async () => {
    expect(READ_SNAPSHOT).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
    const [settings] = await readSnapshot(db, (tx) =>
      tx.execute<{ isolation: string; read_only: string }>(
        sql`select current_setting('transaction_isolation') as isolation,
                   current_setting('transaction_read_only') as read_only`,
      ),
    );
    expect(settings).toEqual({ isolation: 'repeatable read', read_only: 'on' });
  });

  it('a commit between two reads is not seen by the second one; the next snapshot sees it', async () => {
    const model = `snap-${uuidv7().slice(-12)}`;
    await insertKit(model, 'first');
    const reads = await readSnapshot(db, async (tx) => {
      const before = await enginesOf(tx, model);
      // Another connection commits between the two reads (autocommit on the pool).
      await insertKit(model, 'second');
      const after = await enginesOf(tx, model);
      return { before, after };
    });
    expect(reads).toEqual({ before: ['first'], after: ['first'] });
    expect(await readSnapshot(db, (tx) => enginesOf(tx, model))).toEqual(['first', 'second']);
  });

  it('refuses writes', async () => {
    const model = `snap-${uuidv7().slice(-12)}`;
    await expectPgError(
      readSnapshot(db, (tx) => tx.update(kits).set({ note: 'x' }).where(eq(kits.modelSlug, model))),
      READ_ONLY_TRANSACTION,
    );
  });

  it('inside a transaction it joins the caller (a savepoint) and sees its writes', async () => {
    const model = `snap-${uuidv7().slice(-12)}`;
    const inner = await db.transaction(async (tx) => {
      await tx.insert(kits).values({
        makeSlug: 'lada',
        model: 'Vesta',
        modelSlug: model,
        engine: 'own',
        yearsFrom: 2015,
        slug: 'own',
        createdBy: 'test',
        updatedBy: 'test',
      });
      // A separate transaction could not see this uncommitted row.
      return readSnapshot(tx, (sp) => enginesOf(sp, model));
    });
    expect(inner).toEqual(['own']);
  });
});
