import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { testDatabaseUrl } from '@detaly/config/testing';
import { ORDER_ITEM_STATES, ORDER_STATUSES } from '@detaly/domain/statuses';
import { getTableName, isTable } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, migrateDb, MIGRATIONS_FOLDER, schema, type Db } from '../src/client';
import { dropDatabase, ensureDatabase } from '../src/testing';

const schemaTables = Object.values(schema)
  .filter((value) => isTable(value))
  .map((table) => getTableName(table))
  .sort();

describe('migrations on an empty database', () => {
  const url = (() => {
    const base = new URL(testDatabaseUrl());
    base.pathname = `${base.pathname}_mig_${randomBytes(4).toString('hex')}`;
    return base.toString();
  })();
  let db: Db;

  beforeAll(async () => {
    await ensureDatabase(url);
    db = createDb(url, { max: 3 });
  });

  afterAll(async () => {
    await db?.close();
    await dropDatabase(url);
  });

  it('creates every schema table, enum and the order number sequence', async () => {
    await migrateDb(db);

    const tables = await db.$client<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
    expect(tables.map((t) => t.table_name)).toEqual(schemaTables);
    expect(schemaTables).toHaveLength(28);
    expect(schemaTables).not.toContain('vehicles');
    expect(schemaTables).not.toContain('chat_messages');

    const enumValues = async (name: string) =>
      (
        await db.$client<{ v: string }[]>`
          select e.enumlabel as v from pg_enum e join pg_type t on t.oid = e.enumtypid
          where t.typname = ${name} order by e.enumsortorder`
      ).map((r) => r.v);
    expect(await enumValues('order_status')).toEqual([...ORDER_STATUSES]);
    expect(await enumValues('order_item_state')).toEqual([...ORDER_ITEM_STATES]);

    const seq =
      await db.$client`select 1 from pg_sequences where sequencename = 'order_number_seq'`;
    expect(seq).toHaveLength(1);
  });

  it('is idempotent and records every journal entry once', async () => {
    await migrateDb(db);
    await migrateDb(db);
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    const applied = await db.$client`select id from drizzle.__drizzle_migrations`;
    expect(applied).toHaveLength(journal.entries.length);
  });

  it('serializes concurrent runs on a fresh database', async () => {
    const freshUrl = `${url}_c`;
    await ensureDatabase(freshUrl);
    const a = createDb(freshUrl, { max: 3 });
    const b = createDb(freshUrl, { max: 3 });
    try {
      await Promise.all([migrateDb(a), migrateDb(b)]);
      const applied = await a.$client`select id from drizzle.__drizzle_migrations`;
      const journal = JSON.parse(
        await readFile(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
      ) as { entries: unknown[] };
      expect(applied).toHaveLength(journal.entries.length);
    } finally {
      await a.close();
      await b.close();
      await dropDatabase(freshUrl);
    }
  });
});
