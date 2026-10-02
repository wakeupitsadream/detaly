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

/** Masks phones and opaque tokens in `text` and caps its length. */
export function redactText(text: string, max = SAFE_ERROR_MAX): string {
  const masked = text
    .replace(BOT_TOKEN_RE, '[token]')
    // Identifiers (RosskoRateLimitError, not_implemented) and uuids stay readable.
    .replace(OPAQUE_RE, (match) =>
      UUID_RE.test(match) || /^[A-Za-z]+$|^[a-z_-]+$/.test(match) ? match : '[redacted]',
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
