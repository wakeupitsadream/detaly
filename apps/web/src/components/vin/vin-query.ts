import type { VinFormInitial } from './VinForm';

/** Longest pre-filled value per field: the form's own limits. */
const INITIAL_LIMIT = { vin: 24, car: 200, need: 1000 } as const;

/**
 * What the visitor already chose (vinRequestHref: the header search, a brand tile, a category
 * tile) as defaults of the /vin form: the first value of each of `vin`, `car`, `need`, trimmed
 * and cut to the field's limit; empty ones are dropped. Defaults only, the form validates as
 * before.
 */
export function vinFormInitial(
  query: Readonly<Record<string, string | string[] | undefined>>,
): VinFormInitial {
  const initial: VinFormInitial = {};
  for (const key of ['vin', 'car', 'need'] as const) {
    const raw = query[key];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, INITIAL_LIMIT[key]);
    if (value) initial[key] = value;
  }
  return initial;
}
