/**
 * Live transport: npm `soap` (CommonJS, hence the namespace import). One lazily created client
 * per method (`${wsdlBase}/${Method}?wsdl`); a failed WSDL load is forgotten so the next call
 * retries it. soap's own global WSDL cache is disabled: this map is the only cache.
 *
 * Typed XSD values are kept as text (customDeserializer): decimals must reach rubToKop as
 * strings, and dateTime without an offset must not be re-interpreted in the server's TZ.
 */
import * as soap from 'soap';
import { RosskoCallError } from './errors';
import { maskSecrets } from './mask';
import type { RosskoCaller, RosskoMethod } from './types';

type SoapClientLike = Record<string, unknown>;

export interface SoapCallerOptions {
  /** e.g. https://api.rossko.ru/service/v2.1 (no trailing slash needed). */
  wsdlBase: string;
  /** Per-request timeout for both WSDL loading and calls (ROSSKO_TIMEOUT_MS). */
  timeoutMs: number;
  /** Test seam; defaults to soap.createClientAsync. */
  createClient?: (url: string, options: soap.IOptions) => Promise<SoapClientLike>;
}

const keepText = (text: string): string => text;

/** XSD types whose automatic conversion would lose information. */
const CUSTOM_DESERIALIZER = {
  decimal: keepText,
  double: keepText,
  float: keepText,
  dateTime: keepText,
  date: keepText,
};

const MAX_ERROR_LENGTH = 500;

function secretsOf(args: Record<string, unknown>): string[] {
  return [args.KEY1, args.KEY2].filter((v): v is string => typeof v === 'string');
}

function toCallError(
  method: RosskoMethod,
  error: unknown,
  secrets: readonly string[],
  wsdl: boolean,
): RosskoCallError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    message?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  const rawMessage = typeof e.message === 'string' ? e.message : String(error);
  let message = maskSecrets(rawMessage, secrets);
  if (message.length > MAX_ERROR_LENGTH) message = `${message.slice(0, MAX_ERROR_LENGTH)}…`;
  const code = typeof e.code === 'string' ? e.code : null;
  const statusCode = typeof e.response?.status === 'number' ? e.response.status : null;
  const timeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(rawMessage);
  return new RosskoCallError(method, wsdl ? `WSDL load failed: ${message}` : message, {
    timeout,
    wsdl,
    statusCode,
    code,
  });
}

export function createSoapCaller(options: SoapCallerOptions): RosskoCaller {
  const base = options.wsdlBase.replace(/\/+$/, '');
  const createClient =
    options.createClient ??
    ((url: string, opts: soap.IOptions) =>
      soap.createClientAsync(url, opts) as unknown as Promise<SoapClientLike>);
  const clients = new Map<RosskoMethod, Promise<SoapClientLike>>();
  let lastRawResponse: string | null = null;

  function clientFor(method: RosskoMethod): Promise<SoapClientLike> {
    let pending = clients.get(method);
    if (!pending) {
      pending = createClient(`${base}/${method}?wsdl`, {
        disableCache: true,
        wsdl_options: { timeout: options.timeoutMs },
        customDeserializer: CUSTOM_DESERIALIZER,
      });
      clients.set(method, pending);
      // Forget a failed load so the next call retries it.
      void pending.catch(() => {
        if (clients.get(method) === pending) clients.delete(method);
      });
    }
    return pending;
  }

  return {
    get lastRawResponse() {
      return lastRawResponse;
    },
    async call(method, args) {
      const secrets = secretsOf(args);
      let client: SoapClientLike;
      try {
        client = await clientFor(method);
      } catch (error) {
        throw toCallError(method, error, secrets, true);
      }
      const fn = client[`${method}Async`];
      if (typeof fn !== 'function') {
        throw new RosskoCallError(method, 'operation not found in WSDL', { wsdl: true });
      }
      try {
        const reply = (await (fn as (a: unknown, o: unknown) => Promise<unknown>).call(
          client,
          args,
          { timeout: options.timeoutMs },
        )) as [unknown, unknown?];
        lastRawResponse = typeof reply[1] === 'string' ? reply[1] : null;
        return reply[0];
      } catch (error) {
        throw toCallError(method, error, secrets, false);
      }
    },
  };
}
