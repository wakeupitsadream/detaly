import type { StaffSeed } from '@detaly/domain/types';
import { eq, or, type SQL } from 'drizzle-orm';
import type { Executor } from '../executor';
import { staff } from '../schema';

export interface StaffSeedResult {
  inserted: number;
  updated: number;
}

/**
 * Upserts staff from STAFF_SEED_JSON, matching by tg_user_id (or max_user_id when the entry
 * has no Telegram id). Rows are only written when something differs, so re-seeding is a no-op.
 * Staff missing from the env are left as is (deactivate them in the admin).
 */
export async function seedStaff(
  db: Executor,
  entries: readonly StaffSeed[],
): Promise<StaffSeedResult> {
  const result: StaffSeedResult = { inserted: 0, updated: 0 };
  for (const entry of entries) {
    const match: SQL[] = [];
    if (entry.tgUserId !== null) match.push(eq(staff.tgUserId, entry.tgUserId));
    if (entry.maxUserId !== null) match.push(eq(staff.maxUserId, entry.maxUserId));
    if (match.length === 0) {
      throw new Error(`staff seed "${entry.name}": tgUserId or maxUserId is required`);
    }
    const existing = await db
      .select()
      .from(staff)
      .where(or(...match))
      .for('update');
    if (existing.length > 1) {
      throw new Error(
        `staff seed "${entry.name}": tgUserId and maxUserId belong to different staff rows`,
      );
    }
    const values = {
      name: entry.name,
      role: entry.role,
      tgUserId: entry.tgUserId,
      maxUserId: entry.maxUserId,
      isActive: entry.isActive,
    };
    const row = existing[0];
    if (!row) {
      await db.insert(staff).values(values);
      result.inserted += 1;
      continue;
    }
    // Keep a Telegram/MAX id the env does not mention (it may have been added in the admin).
    const next = {
      ...values,
      tgUserId: values.tgUserId ?? row.tgUserId,
      maxUserId: values.maxUserId ?? row.maxUserId,
    };
    const changed =
      row.name !== next.name ||
      row.role !== next.role ||
      row.tgUserId !== next.tgUserId ||
      row.maxUserId !== next.maxUserId ||
      row.isActive !== next.isActive;
    if (changed) {
      await db.update(staff).set(next).where(eq(staff.id, row.id));
      result.updated += 1;
    }
  }
  return result;
}
