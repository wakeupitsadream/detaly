/** VIN layer contracts (PLAN section 4 "VIN-слой"). */
import type { VinProvider } from '@detaly/domain/statuses';

export interface VinCandidate {
  brand: string;
  article: string;
  quantity: number;
  note: string | null;
}

export interface VinResolution {
  provider: VinProvider;
  /**
   * resolved: candidates come from a catalogue (phase 3);
   * manual_required: a seller must answer the request by hand (phase 1C, or budget exhausted).
   */
  status: 'resolved' | 'manual_required';
  vehicle: string | null;
  candidates: VinCandidate[];
}

export interface VinResolver {
  readonly provider: VinProvider;
  /** `vin` must already be normalized (normalizeVin); `need` is the client's description. */
  resolve(vin: string, need: string): Promise<VinResolution>;
}

export class InvalidVinError extends Error {
  override name = 'InvalidVinError';
}
