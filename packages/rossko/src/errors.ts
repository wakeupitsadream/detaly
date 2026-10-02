/**
 * Errors thrown by @detaly/rossko. Messages never contain KEY1/KEY2: SOAP and HTTP errors are
 * re-wrapped with masked text and without `cause`, so a logger cannot serialize the request.
 */
import type { CallPriority, RosskoMethod } from './types';

export class CheckoutDisabledError extends Error {
  constructor() {
    super('Rossko checkout is disabled (ROSSKO_ALLOW_CHECKOUT=false)');
    this.name = 'CheckoutDisabledError';
  }
}

export type QuotaBreakerReason = 'breaker' | 'exhausted';

/**
 * Daily quota guard: `breaker` when a search hits ROSSKO_QUOTA_BREAKER_PCT of the daily limit
 * (critical calls still pass), `exhausted` when any call hits 100%.
 */
export class QuotaBreakerError extends Error {
  readonly reason: QuotaBreakerReason;
  readonly priority: CallPriority | null;
  /** Calls counted for the current Moscow day. */
  readonly dailyCount: number;
  /** Threshold applied to this priority. */
  readonly limit: number;

  constructor(
    message = 'Rossko daily quota breaker is open',
    details: {
      reason?: QuotaBreakerReason;
      priority?: CallPriority | null;
      dailyCount?: number;
      limit?: number;
    } = {},
  ) {
    super(message);
    this.name = 'QuotaBreakerError';
    this.reason = details.reason ?? 'breaker';
    this.priority = details.priority ?? null;
    this.dailyCount = details.dailyCount ?? 0;
    this.limit = details.limit ?? 0;
  }
}

/** The per-minute window is full and the slot frees up later than `maxWaitMs` allows. */
export class RosskoRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Rossko per-minute limit reached, retry after ${retryAfterMs} ms`);
    this.name = 'RosskoRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Transport or SOAP fault while calling Rossko. The message is masked. */
export class RosskoCallError extends Error {
  readonly method: RosskoMethod;
  /** true when the request timed out: the call may still have been executed by Rossko. */
  readonly timeout: boolean;
  /** WSDL could not be loaded (the request was not sent). */
  readonly wsdl: boolean;
  readonly statusCode: number | null;
  readonly code: string | null;

  constructor(
    method: RosskoMethod,
    message: string,
    details: {
      timeout?: boolean;
      wsdl?: boolean;
      statusCode?: number | null;
      code?: string | null;
    } = {},
  ) {
    super(`Rossko ${method}: ${message}`);
    this.name = 'RosskoCallError';
    this.method = method;
    this.timeout = details.timeout ?? false;
    this.wsdl = details.wsdl ?? false;
    this.statusCode = details.statusCode ?? null;
    this.code = details.code ?? null;
  }
}
