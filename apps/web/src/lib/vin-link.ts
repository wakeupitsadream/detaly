/**
 * Link to the VIN request form with what the visitor already chose (redesign 2): a VIN typed
 * into the header search, a car make from the brand grid, a part category tile. /vin pre-fills
 * its fields from these query parameters. Pure, so server and client components share it.
 */
export interface VinRequestLink {
  /** VIN as typed or normalized; trimmed, sent as is (the form validates it). */
  vin?: string | null;
  /** Make and model, e.g. «Lada» from the brand grid. */
  car?: string | null;
  /** What is needed, e.g. a PART_CATEGORIES need text. */
  need?: string | null;
}

/** Longest value put into the link: the form's own limits are lower anyway. */
const MAX_VALUE_LENGTH = 200;

export function vinRequestHref({ vin, car, need }: VinRequestLink = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of [
    ['vin', vin],
    ['car', car],
    ['need', need],
  ] as const) {
    const clean = value?.trim().slice(0, MAX_VALUE_LENGTH);
    if (clean) params.set(key, clean);
  }
  const query = params.toString();
  return query ? `/vin?${query}` : '/vin';
}
