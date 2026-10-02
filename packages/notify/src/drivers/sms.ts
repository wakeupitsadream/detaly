/**
 * SMS driver (phase 1B): SMS Aero v2 or smsc.ru over HTTP GET, behind the ChannelDriver
 * interface. The text is renderSmsText (two segments at most, the link kept whole).
 *
 * Errors: 4xx and gateway refusals -> UnrecoverableSmsError (the worker turns it into BullMQ
 * UnrecoverableError); network errors, timeouts, 5xx, 408 and 429 -> SmsGatewayError (the queue
 * retries). Neither the number nor the text nor the credentials ever reach an error message or
 * a log line: only the provider, the HTTP status or the gateway error code, and the message id.
 *
 * VERIFY: request and response formats of both gateways (docs/external.md, section 5):
 * - SMS Aero v2: GET {url}/sms/send?number=79…&text=…&sign=…, Basic login:apiKey,
 *   response {success, data: {id, cost}, message}; refusals may come as HTTP 200 with
 *   success=false or as 4xx.
 * - smsc.ru: GET {url}/send.php?login&psw&phones&mes&sender&fmt=3&charset=utf-8&cost=2,
 *   response {id, cnt, cost} or {error, error_code} with HTTP 200; codes 4 (IP blocked for a
 *   while) and 9 (too many requests) are temporary.
 */
import type { Env } from '@detaly/config';
import {
  ChannelSkippedError,
  type ChannelDriver,
  type DriverSendOptions,
  type DriverSendResult,
} from '../notifier';
import type { SmsGuard } from '../sms-guard';
import { renderSmsText } from '../sms-text';
import type { RenderedMessage } from '../types';

export type SmsProvider = 'smsaero' | 'smsc';

/** VERIFY: gateway base URLs (SMS_API_URL overrides). */
export const SMS_DEFAULT_API_URL: Record<SmsProvider, string> = {
  smsaero: 'https://gate.smsaero.ru/v2',
  smsc: 'https://smsc.ru/sys',
};

const DEFAULT_TIMEOUT_MS = 15_000;

/** Minimal structured logger (pino satisfies it). */
export interface SmsLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface SmsDriverOptions {
  provider: SmsProvider;
  /** SMS Aero: account e-mail; smsc: login. */
  login: string;
  /** SMS Aero API key; smsc password or API password. */
  apiKey: string;
  /** Registered sender name (SMS Aero `sign`, smsc `sender`). Required by SMS Aero. */
  sender?: string | null;
  apiUrl?: string | null;
  fetch?: typeof fetch;
  /** Rate limit and budget (createSmsGuard); a refusal -> ChannelSkippedError (`skipped`). */
  guard?: SmsGuard | null;
  timeoutMs?: number;
  logger?: SmsLogger | null;
}

/** The gateway refused the message for good (bad number, auth, balance, sender): no retry. */
export class UnrecoverableSmsError extends Error {
  override name = 'UnrecoverableSmsError';
  constructor(
    readonly provider: SmsProvider,
    /** HTTP status or gateway error code; never the number or the text. */
    readonly code: string,
  ) {
    super(`${provider}: sms rejected (${code})`);
  }
}

/** Temporary failure (network, timeout, 5xx, 429): the queue retries. */
export class SmsGatewayError extends Error {
  override name = 'SmsGatewayError';
  constructor(
    readonly provider: SmsProvider,
    readonly code: string,
  ) {
    super(`${provider}: sms gateway unavailable (${code})`);
  }
}

/** '+7 (999) 123-45-67' -> '79991234567'; only +7 mobile numbers get SMS. */
function gatewayNumber(provider: SmsProvider, address: string): string {
  const digits = address.replace(/\D/g, '');
  const normalized =
    digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
  if (!/^79\d{9}$/.test(normalized)) throw new UnrecoverableSmsError(provider, 'invalid_number');
  return normalized;
}

/** 3.69 / '3.69' / '1,40' (rubles) -> 369 kopecks; anything else -> null. */
export function rubToKopLoose(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim().replace(',', '.');
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) return null;
  const rub = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(3, '0');
  // Kopecks plus the third decimal for half-up rounding.
  const kop = rub * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(kop) ? kop : null;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : 'network';
}

function isTemporaryStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

interface GatewayCall {
  url: URL;
  headers: Record<string, string>;
}

interface Gateway {
  request(number: string, text: string): GatewayCall;
  /** Interprets a parsed 2xx body. */
  parse(body: unknown): DriverSendResult;
}

function smsAero(options: SmsDriverOptions, base: string): Gateway {
  const sign = options.sender ?? '';
  if (sign === '') throw new Error('smsaero: SMS_SENDER (sign) is required');
  const auth = Buffer.from(`${options.login}:${options.apiKey}`).toString('base64');
  return {
    request(number, text) {
      const url = new URL(`${base}/sms/send`);
      url.searchParams.set('number', number);
      url.searchParams.set('text', text);
      url.searchParams.set('sign', sign);
      return { url, headers: { authorization: `Basic ${auth}`, accept: 'application/json' } };
    },
    parse(body) {
      const b = body as { success?: unknown; data?: { id?: unknown; cost?: unknown } | null };
      if (b === null || typeof b !== 'object' || b.success !== true) {
        throw new UnrecoverableSmsError('smsaero', 'rejected');
      }
      const id = b.data?.id;
      if (typeof id !== 'number' && typeof id !== 'string') {
        throw new UnrecoverableSmsError('smsaero', 'no_id');
      }
      return { externalId: String(id), costKop: rubToKopLoose(b.data?.cost) };
    },
  };
}

/** smsc error codes that clear by themselves (VERIFY: smsc.ru/api/http/send/). */
const SMSC_TEMPORARY_CODES = new Set(['4', '9']);

function smsc(options: SmsDriverOptions, base: string): Gateway {
  return {
    request(number, text) {
      const url = new URL(`${base}/send.php`);
      url.searchParams.set('login', options.login);
      url.searchParams.set('psw', options.apiKey);
      url.searchParams.set('phones', number);
      url.searchParams.set('mes', text);
      if (options.sender) url.searchParams.set('sender', options.sender);
      url.searchParams.set('fmt', '3');
      url.searchParams.set('charset', 'utf-8');
      // VERIFY: cost=2 sends and adds the price to the response.
      url.searchParams.set('cost', '2');
      return { url, headers: { accept: 'application/json' } };
    },
    parse(body) {
      const b = body as {
        id?: unknown;
        cost?: unknown;
        error?: unknown;
        error_code?: unknown;
      } | null;
      if (b === null || typeof b !== 'object') throw new UnrecoverableSmsError('smsc', 'malformed');
      if (b.error !== undefined || b.error_code !== undefined) {
        const code = String(b.error_code ?? 'error');
        if (SMSC_TEMPORARY_CODES.has(code)) throw new SmsGatewayError('smsc', `error_code ${code}`);
        throw new UnrecoverableSmsError('smsc', `error_code ${code}`);
      }
      if (typeof b.id !== 'number' && typeof b.id !== 'string') {
        throw new UnrecoverableSmsError('smsc', 'no_id');
      }
      return { externalId: String(b.id), costKop: rubToKopLoose(b.cost) };
    },
  };
}

export function createSmsDriver(options: SmsDriverOptions): ChannelDriver {
  const { provider } = options;
  if (options.login === '' || options.apiKey === '') {
    throw new Error(`${provider}: login and api key are required`);
  }
  const base = (options.apiUrl ?? SMS_DEFAULT_API_URL[provider]).replace(/\/+$/, '');
  const gateway = provider === 'smsaero' ? smsAero(options, base) : smsc(options, base);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.logger ?? null;

  return {
    channel: 'sms',
    async send(
      address: string,
      message: RenderedMessage,
      sendOptions: DriverSendOptions = {},
    ): Promise<DriverSendResult> {
      const number = gatewayNumber(provider, address);
      if (options.guard) {
        const verdict = await options.guard.check(
          number,
          sendOptions.dedupeKey === undefined ? {} : { dedupeKey: sendOptions.dedupeKey },
        );
        if (!verdict.allowed) {
          log?.info({ provider, reason: verdict.reason }, 'sms skipped');
          throw new ChannelSkippedError('sms', verdict.reason);
        }
      }

      const call = gateway.request(number, renderSmsText(message));
      const doFetch = options.fetch ?? globalThis.fetch;
      let response: Response;
      try {
        response = await doFetch(call.url, {
          method: 'GET',
          headers: call.headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // The cause may carry the request URL (credentials, number): only its code goes on.
        const code = errorCode(error);
        log?.warn({ provider, code }, 'sms gateway unreachable');
        throw new SmsGatewayError(provider, code);
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const code = `http ${response.status}`;
        log?.warn({ provider, code }, 'sms gateway error');
        if (isTemporaryStatus(response.status)) throw new SmsGatewayError(provider, code);
        throw new UnrecoverableSmsError(provider, code);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // A 2xx with a broken body: the SMS may have gone out, a retry could send it twice.
        log?.warn({ provider, code: 'malformed' }, 'sms gateway error');
        throw new UnrecoverableSmsError(provider, 'malformed');
      }
      try {
        const result = gateway.parse(body);
        log?.info({ provider, externalId: result.externalId }, 'sms sent');
        return result;
      } catch (error) {
        if (error instanceof UnrecoverableSmsError || error instanceof SmsGatewayError) {
          log?.warn({ provider, code: error.code }, 'sms gateway error');
        }
        throw error;
      }
    },
  };
}

type SmsEnv = Pick<
  Env,
  'SMS_PROVIDER' | 'SMS_LOGIN' | 'SMS_API_KEY' | 'SMS_SENDER' | 'SMS_API_URL'
>;

/**
 * Driver options from env, or null when SMS is off (SMS_PROVIDER=none) or incomplete (no login,
 * key, or SMS Aero without a sender name): the Notifier then skips SMS with
 * `no_messenger:sms_unavailable`.
 */
export function smsDriverOptionsFromEnv(
  env: SmsEnv,
): Pick<SmsDriverOptions, 'provider' | 'login' | 'apiKey' | 'sender' | 'apiUrl'> | null {
  if (env.SMS_PROVIDER === 'none') return null;
  if (!env.SMS_LOGIN || !env.SMS_API_KEY) return null;
  if (env.SMS_PROVIDER === 'smsaero' && !env.SMS_SENDER) return null;
  return {
    provider: env.SMS_PROVIDER,
    login: env.SMS_LOGIN,
    apiKey: env.SMS_API_KEY,
    sender: env.SMS_SENDER ?? null,
    apiUrl: env.SMS_API_URL ?? null,
  };
}
