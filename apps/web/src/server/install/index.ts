/**
 * Contract for pages: the install plan per offer and per date. STUB from the foundation package
 * (docs/design.md, package F): no plan yet, so pages render their fallback. Package P1 replaces
 * this file with the real computation (packages/domain install-window + a LoadSource); the
 * signatures and ./types.ts stay as they are.
 */
import type { IsoDate, OfferView } from '@detaly/domain';
import type { InstallPlanView } from './types';

export type { InstallPlanView } from './types';

/** Plan per OfferView.id; an offer without a plan is absent or null. */
export async function planInstallForOffers(
  _offers: readonly OfferView[],
  _now: Date,
): Promise<Map<string, InstallPlanView | null>> {
  return new Map();
}

/** Plan for a part that is at the pickup point on `etaDate` (the order page). */
export async function planInstallForDate(
  _etaDate: IsoDate,
  _now: Date,
): Promise<InstallPlanView | null> {
  return null;
}
