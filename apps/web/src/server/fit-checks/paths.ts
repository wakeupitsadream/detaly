/**
 * Addresses of the step 4 fit check (docs/fit-check.md) shared by the handlers, the cart page and
 * src/proxy.ts. No imports: the proxy loads it for every request.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cart line id as posted or put in a URL (lower case), or null. */
export function lineIdOf(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

/** POST target of the «Отправить мастеру» form. */
export const FIT_CHECKS_PATH = '/api/fit-checks';

/** The anchor of a cart line's fit check block (`#fit-<line id>`). */
export function fitAnchor(lineId: string): string {
  return `fit-${lineId}`;
}

/** The form's action: the line it was opened from rides in the URL (an id, not personal data). */
export function fitFormAction(lineId: string): string {
  return `${FIT_CHECKS_PATH}?line=${lineId}`;
}

/**
 * DEMO_MODE (step 4, docs/fit-check.md): where a fit check form post without JavaScript goes. The
 * proxy answers it WITHOUT reading the body, so the VIN never reaches the server: the cart
 * shows the demo answer on the line named in the action URL.
 */
export function demoFitLocation(search: URLSearchParams): string {
  const line = lineIdOf(search.get('line'));
  return line ? `/cart?fit_demo=${line}#${fitAnchor(line)}` : '/cart';
}
