/** Field parsing shared by the admin form handlers (orders, claims, VIN requests). */

/** «1 234,50» / «1234.5» / «1234» -> kopecks; null for anything else. */
export function parseRubToKop(raw: string): number | null {
  const text = raw.replace(/\s/g, '').replace(',', '.');
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match?.[1]) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** A trimmed form field, cut to `max` characters ('' when missing). */
export function formField(form: URLSearchParams, name: string, max = 500): string {
  return (form.get(name) ?? '').trim().slice(0, max);
}
