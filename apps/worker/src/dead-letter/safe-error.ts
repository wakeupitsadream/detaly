// Error text that may be stored (dead-letter jobs, notifications.error) and logged: processors
// throw errors without PD by contract, but a third-party message may still echo a phone number,
// an order token or a bot token. Those are masked here; uuids (order ids) are kept.

/** Longest error text kept in dead-letter data, alerts and logs. */
export const SAFE_ERROR_MAX = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Telegram bot token `<id>:<secret>` (also inside Bot API URLs). */
const BOT_TOKEN_RE = /\d{5,}:[\w-]{30,}/g;
/** Russian phone numbers: +7 999 123-45-67, 8(999)1234567, 79991234567. */
const PHONE_RE = /(?:\+7|\b[78])[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g;
/** Long opaque strings (order tokens are >= 128 bit base64url, secrets, keys). */
const OPAQUE_RE = /[A-Za-z0-9_-]{20,}/g;
/** Order page links `/o/<token>`: the token is masked whatever it looks like. */
const ORDER_LINK_RE = /\/o\/[A-Za-z0-9_-]+/g;
/**
 * Long words kept readable: CamelCase/camelCase (RosskoRateLimitError), snake_case and
 * kebab-case in lower case (supplier_checkout_failed), UPPER_SNAKE env names
 * (ROSSKO_ALLOW_CHECKOUT). A random base64url token of 22+ characters matches none of them
 * with any practical probability (a plain "letters only" rule would keep ~1% of 128-bit tokens).
 */
const IDENTIFIER_RE =
  /^(?:[A-Za-z][a-z]*(?:[A-Z][a-z]+)*|[a-z]+(?:[_-][a-z]+)*|[A-Z]+(?:_[A-Z]+)+)$/;

/** Masks phones and opaque tokens in `text` and caps its length. */
export function redactText(text: string, max = SAFE_ERROR_MAX): string {
  const masked = text
    .replace(BOT_TOKEN_RE, '[token]')
    .replace(ORDER_LINK_RE, '/o/[token]')
    // Identifiers (RosskoRateLimitError, not_implemented) and uuids stay readable.
    .replace(OPAQUE_RE, (match) =>
      UUID_RE.test(match) || IDENTIFIER_RE.test(match) ? match : '[redacted]',
    )
    .replace(PHONE_RE, '[phone]');
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

/** `Name: message` of any thrown value, PD-masked. */
export function safeErrorMessage(error: unknown, max = SAFE_ERROR_MAX): string {
  if (error instanceof Error) {
    const head = error.name && error.name !== 'Error' ? `${error.name}: ` : '';
    return redactText(`${head}${error.message}`, max);
  }
  return redactText(String(error), max);
}
