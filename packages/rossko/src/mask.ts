/**
 * Secret masking for anything that leaves the process: smoke-script output (raw XML and JSON),
 * error messages, logs.
 */

export const MASK = '***';

/** Field names whose values are always masked, in XML (`<ns:KEY1>`) and JSON (`"KEY1":`). */
const SECRET_FIELDS = ['KEY1', 'KEY2'];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces every occurrence of the given secret values and the contents of KEY1/KEY2 fields
 * with `***`. Secrets shorter than 4 characters are ignored (they would mangle unrelated text);
 * KEY1/KEY2 fields are masked regardless of their value.
 */
export function maskSecrets(
  text: string,
  secrets: readonly (string | null | undefined)[] = [],
): string {
  let out = text;
  const values = secrets
    .filter((s): s is string => typeof s === 'string' && s.trim().length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of values) {
    out = out.split(secret).join(MASK);
    // XML-escaped form of the same value (e.g. '&' -> '&amp;')
    const escaped = secret.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (escaped !== secret) out = out.split(escaped).join(MASK);
  }
  for (const name of SECRET_FIELDS) {
    const n = escapeRegExp(name);
    // <KEY1>..</KEY1>, <ns1:KEY1 attr="x">..</ns1:KEY1>
    out = out.replace(
      new RegExp(`(<(?:[\\w.-]+:)?${n}(?:\\s[^>]*)?>)([^<]*)(</(?:[\\w.-]+:)?${n}>)`, 'g'),
      `$1${MASK}$3`,
    );
    // "KEY1": "..."
    out = out.replace(new RegExp(`("${n}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'g'), `$1"${MASK}"`);
    // KEY1=... in query strings
    out = out.replace(new RegExp(`(\\b${n}=)[^&\\s"'<]*`, 'g'), `$1${MASK}`);
  }
  return out;
}
