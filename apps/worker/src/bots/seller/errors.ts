// Log-safe view of grammY errors. grammY's HttpError keeps the underlying node-fetch error,
// whose message is "request to https://api.telegram.org/bot<TOKEN>/<method> failed, ...",
// and GrammyError keeps the request payload (message text, chat ids). Logging either object
// as is would put the bot token and message contents into the logs.
import { GrammyError, HttpError } from 'grammy';

export interface SafeBotError {
  name: string;
  message: string;
  /** Bot API method that failed (GrammyError). */
  method?: string;
  /** Bot API error code (GrammyError), e.g. 401 or 409. */
  errorCode?: number;
  /** Message of the underlying network error (HttpError), token removed. */
  cause?: string;
  /** Error code of the underlying network error, e.g. ECONNREFUSED. */
  code?: string;
}

const REDACTED = '[redacted]';
/** Any Bot API URL path segment `bot<id>:<secret>`, whatever token it carries. */
const TOKEN_IN_URL = /bot\d+:[\w-]+/g;

export function redactToken(text: string, token?: string): string {
  let result = text;
  if (token) result = result.split(token).join(REDACTED);
  return result.replace(TOKEN_IN_URL, `bot${REDACTED}`);
}

export function describeBotError(error: unknown, token?: string): SafeBotError {
  if (!(error instanceof Error)) {
    return { name: 'NonError', message: redactToken(String(error), token) };
  }
  const safe: SafeBotError = { name: error.name, message: redactToken(error.message, token) };
  if (error instanceof GrammyError) {
    safe.method = error.method;
    safe.errorCode = error.error_code;
  }
  const inner: unknown = error instanceof HttpError ? error.error : error.cause;
  if (inner instanceof Error) {
    safe.cause = redactToken(inner.message, token);
    const code = (inner as { code?: unknown }).code;
    if (typeof code === 'string') safe.code = code;
  }
  return safe;
}

/** An Error that carries only the log-safe description (for rethrowing). */
export function toSafeError(error: unknown, token?: string): Error {
  const safe = describeBotError(error, token);
  const message = safe.cause ? `${safe.message} (${safe.cause})` : safe.message;
  const result = new Error(message);
  result.name = safe.name;
  return result;
}
