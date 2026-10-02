// loadStaffTgIds against the real schema in `${DATABASE_URL_TEST}_worker`.
import { createDb, staff, type Db } from '@detaly/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { loadStaffTgIds } from '../src/bots/seller/staff';

let db: Db;

beforeAll(() => {
  const url = inject('workerDatabaseUrl');
  if (!url) {
    throw new Error('DATABASE_URL_TEST is not set: eval "$(scripts/dev-db.sh env)"');
  }
  db = createDb(url, { max: 2 });
});

afterAll(async () => {
  await db?.close();
});

describe('loadStaffTgIds', () => {
  it('returns Telegram ids of active staff only', async () => {
    // Ids far outside anything a seed would use; the table is cleaned up below.
    const rows: (typeof staff.$inferInsert)[] = [
      { name: 'Активный', role: 'owner', tgUserId: 9_100_000_001, isActive: true },
      { name: 'Уволен', role: 'seller', tgUserId: 9_100_000_002, isActive: false },
      { name: 'Только MAX', role: 'seller', maxUserId: 9_100_000_003, isActive: true },
    ];
    const inserted = await db.insert(staff).values(rows).returning({ id: staff.id });
    try {
      const ids = await loadStaffTgIds(db);
      expect(ids.has(9_100_000_001)).toBe(true);
      expect(ids.has(9_100_000_002)).toBe(false);
      expect(ids.has(9_100_000_003)).toBe(false);
    } finally {
      // drizzle-orm is not a direct dependency of the worker: plain SQL for the cleanup.
      const ids = inserted.map((row) => row.id);
      await db.$client`delete from staff where id in ${db.$client(ids)}`;
    }
  });
});
