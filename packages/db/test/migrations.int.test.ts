import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { testDatabaseUrl } from '@detaly/config/testing';
import {
  APPROVAL_DECISIONS,
  APPROVAL_KINDS,
  ORDER_ITEM_STATES,
  ORDER_STATUSES,
  REFUND_SCOPES,
} from '@detaly/domain/statuses';
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
    // 28 tables of phases 0 and 1A plus outbox, client_approvals and seller_cards (1B)
    expect(schemaTables).toHaveLength(31);
    expect(schemaTables).toEqual(
      expect.arrayContaining(['outbox', 'client_approvals', 'seller_cards']),
    );
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
    expect(await enumValues('refund_scope')).toEqual([...REFUND_SCOPES]);
    expect(await enumValues('approval_kind')).toEqual([...APPROVAL_KINDS]);
    expect(await enumValues('approval_decision')).toEqual([...APPROVAL_DECISIONS]);

    const seq =
      await db.$client`select 1 from pg_sequences where sequencename = 'order_number_seq'`;
    expect(seq).toHaveLength(1);
  });

  it('names columns in plain snake_case (no digit split like upd_s_3_key)', async () => {
    const columns = await db.$client<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' order by table_name, column_name`;
    const split = columns
      .map((c) => `${c.table_name}.${c.column_name}`)
      .filter((name) => /(^|[._])[a-z]_[0-9]/.test(name));
    expect(split).toEqual([]);
    expect(columns).toContainEqual({ table_name: 'supplier_orders', column_name: 'upd_s3_key' });
    expect(columns).toContainEqual({ table_name: 'order_photos', column_name: 's3_key' });
    // phase 1C (0004): no new tables, new columns on the phase 0 tables
    for (const [table, column] of [
      ['claims', 'request_key'],
      ['claims', 'refund_id'],
      ['install_bookings', 'request_key'],
      ['order_photos', 'claim_id'],
      ['vin_requests', 'preview'],
      ['vin_requests', 'photos_deleted_at'],
      ['carts', 'proposal_expires_at'],
      ['orders', 'vin_request_id'],
      ['consents', 'vin_request_id'],
      ['link_tokens', 'used_by_external_id'],
      ['seller_cards', 'vin_request_id'],
      ['notifications', 'vin_request_id'],
    ] as const) {
      expect(columns).toContainEqual({ table_name: table, column_name: column });
    }
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
