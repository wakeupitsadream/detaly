/**
 * How the storefront names its pickup point (decision of 08.10, docs/design-v2.md): the shop is
 * an independent auto parts shop, and the service where the parts are handed over appears only
 * as the pickup point — its name, address, hours and phone from env (PICKUP_*).
 */

/** The city of the only pickup point (stock badges say «В Оренбурге» too). */
export const PICKUP_CITY = 'Оренбург';

const CITY_PREFIX_RE = /^\s*(?:г\.?\s*)?Оренбург\s*,\s*/iu;

/**
 * The address without the city in front: «г. Оренбург, ул. Тестовая, 1» -> «ул. Тестовая, 1».
 * The header and the about card's description say the city already; anything else is kept as
 * written.
 */
export function shortPickupAddress(address: string): string {
  return address.replace(CITY_PREFIX_RE, '').trim() || address.trim();
}

/**
 * The header line after the pin: «Пункт выдачи: ул. Тестовая, 1»; without an address the point's
 * name; with neither, «Пункт выдачи в Оренбурге». `value` is what follows the colon (drawn bold).
 */
export function pickupLine(pickup: { name?: string | null; address?: string | null }): {
  label: string;
  value: string | null;
} {
  const value = pickup.address ? shortPickupAddress(pickup.address) : (pickup.name ?? null);
  return value
    ? { label: 'Пункт выдачи:', value }
    : { label: `Пункт выдачи в ${PICKUP_CITY}е`, value: null };
}

/** The same line as plain text (tests, titles). */
export function pickupLineText(pickup: { name?: string | null; address?: string | null }): string {
  const { label, value } = pickupLine(pickup);
  return value ? `${label} ${value}` : label;
}
