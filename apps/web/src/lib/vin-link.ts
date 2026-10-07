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

/** 16 or 18 Latin letters and digits: a VIN with a character lost or added (a VIN has 17). */
const NEAR_VIN_RE = /^(?:[A-Za-z0-9]{16}|[A-Za-z0-9]{18})$/;
/** Words, not an article: Cyrillic letters or a space between words. */
const WORDS_RE = /[А-Яа-яЁё]|\S\s+\S/;

/**
 * «Подобрать по VIN» from a search query: an article goes into the request as «Артикул …»,
 * words («масляный фильтр») go as they are, and a near-VIN (16 or 18 characters) goes into the
 * VIN field with `nearVin` set, so the page can say that a VIN has 17 characters.
 */
export function vinRequestFromQuery(query: string): { href: string; nearVin: boolean } {
  const clean = query.trim();
  if (NEAR_VIN_RE.test(clean)) return { href: vinRequestHref({ vin: clean }), nearVin: true };
  if (clean === '') return { href: vinRequestHref(), nearVin: false };
  const need = WORDS_RE.test(clean) ? clean : `Артикул ${clean}`;
  return { href: vinRequestHref({ need }), nearVin: false };
}
