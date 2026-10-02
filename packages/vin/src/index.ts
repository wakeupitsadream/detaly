// Public API of @detaly/vin. Step 0 stubs; implemented in work package P2.
import type { VinProvider } from '@detaly/domain/statuses';

/** 17 characters, digits and Latin letters except I, O, Q. */
export function isValidVin(_vin: string): boolean {
  throw new Error('not implemented: @detaly/vin isValidVin');
}

export interface VinCandidate {
  brand: string;
  article: string;
  quantity: number;
  note: string | null;
}

export interface VinResolution {
  provider: VinProvider;
  vehicle: string | null;
  candidates: VinCandidate[];
}

export interface VinResolver {
  readonly provider: VinProvider;
  resolve(vin: string, need: string): Promise<VinResolution>;
}

/** Phase 1C: a seller answers VIN requests by hand. */
export function createManualResolver(): VinResolver {
  throw new Error('not implemented: @detaly/vin createManualResolver');
}
