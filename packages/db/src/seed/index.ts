import type { Env } from '@detaly/config';
import type { Database } from '../client';
import { seedExcluded } from './excluded';
import { seedLegal, type LegalSeedOptions, type LegalSeedResult } from './legal';
import { seedSettings } from './settings';
import { seedStaff, type StaffSeedResult } from './staff';

export type SeedOptions = LegalSeedOptions;

export interface SeedReport {
  settingsInserted: string[];
  staff: StaffSeedResult;
  excludedInserted: string[];
  legal: LegalSeedResult;
}

/**
 * Idempotent seed in one transaction: settings and excluded_groups with ON CONFLICT DO NOTHING
 * (admin edits win), staff upserted from STAFF_SEED_JSON, legal texts synced from content/legal.
 * Any failure (e.g. an edited published legal text) rolls everything back.
 */
export async function seed(db: Database, env: Env, options: SeedOptions = {}): Promise<SeedReport> {
  return db.transaction(async (tx) => ({
    settingsInserted: await seedSettings(tx, env),
    staff: await seedStaff(tx, env.STAFF_SEED_JSON),
    excludedInserted: await seedExcluded(tx),
    legal: await seedLegal(tx, env, options),
  }));
}

/** True when a seed run changed nothing (used by the CLI log and tests). */
export function isNoopSeed(report: SeedReport): boolean {
  return (
    report.settingsInserted.length === 0 &&
    report.staff.inserted === 0 &&
    report.staff.updated === 0 &&
    report.excludedInserted.length === 0 &&
    report.legal.inserted.length === 0 &&
    report.legal.updated.length === 0 &&
    report.legal.published.length === 0
  );
}
