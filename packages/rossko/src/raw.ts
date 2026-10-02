/**
 * Defensive readers for parsed SOAP payloads. node-soap returns a single object instead of a
 * one-element array, may use different key casing, and converts typed XSD values (we keep
 * decimals and dates as strings via customDeserializer, but fixtures may hold either form).
 */

export type RawObject = Record<string, unknown>;

export function isObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** undefined/null -> [], array -> array, anything else -> [value]. */
export function toArray<T = unknown>(value: T | readonly T[] | null | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}

/**
 * Own property by exact name, then case-insensitively (`PartsList` vs `partsList`).
 * Inherited properties (`constructor`, `toString`) are never returned.
 */
export function field(obj: unknown, name: string): unknown {
  if (!isObject(obj)) return undefined;
  if (Object.hasOwn(obj, name)) return obj[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === lower) return obj[key];
  }
  return undefined;
}

/** First defined property among `names`. */
export function firstField(obj: unknown, names: readonly string[]): unknown {
  for (const name of names) {
    const value = field(obj, name);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** `{Part: [...]}` / `{Part: {...}}` / `[...]` -> items. */
export function listOf(container: unknown, itemNames: readonly string[]): unknown[] {
  if (Array.isArray(container)) return container;
  if (!isObject(container)) return [];
  return toArray(firstField(container, itemNames));
}

/** Text value: strings trimmed, numbers/booleans stringified, Date to ISO, empty -> null. */
export function str(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  // xsi:nil and other attribute-only nodes arrive as objects
  if (isObject(value)) return str(value.$value);
  return null;
}

/** Leading integer of a value: 6, '6', ' 10 ', '>10', '10+' -> number; otherwise null. */
export function int(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  const text = str(value);
  if (text === null) return null;
  const match = /-?\d+/.exec(text.replace(/\s/g, ''));
  return match ? Number(match[0]) : null;
}

/** true/'true'/'1'/1 -> true; false/'false'/'0'/0 -> false; otherwise null. */
export function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = str(value)?.toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return null;
}

/**
 * Unwraps `{SearchResult: {...}}` (or any `*Result` key) to the inner object. Returns the
 * object itself when it already looks like a result (`success` present).
 */
export function unwrapResult(raw: unknown): RawObject | null {
  if (!isObject(raw)) return null;
  if (field(raw, 'success') !== undefined) return raw;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (/result$/i.test(key) && isObject(value)) return value;
  }
  // GetSearchResponse -> SearchResult nesting
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (/response$/i.test(key) && isObject(value)) return unwrapResult(value);
  }
  return null;
}
