// Public API of @detaly/rossko. Step 0 stubs; implemented in work package P3.
// SOAP v2.1 client (npm `soap`), fixture caller, Redis limiter and cache, resilient mapper.
import type { Redis } from 'ioredis';
import type { Offer } from '@detaly/domain/types';

function notImplemented(name: string): never {
  throw new Error(`not implemented: @detaly/rossko ${name}`);
}

/** Invokes one Rossko method with already-built arguments and returns the raw result. */
export interface RosskoCaller {
  call(method: RosskoMethod, args: Record<string, unknown>): Promise<unknown>;
}

export type RosskoMethod = 'GetSearch' | 'GetCheckoutDetails' | 'GetCheckout' | 'GetOrders';

export function createSoapCaller(_options: { wsdlBase: string; timeoutMs: number }): RosskoCaller {
  return notImplemented('createSoapCaller');
}

export function createFixtureCaller(_dir: string): RosskoCaller {
  return notImplemented('createFixtureCaller');
}

export type CallPriority = 'search' | 'critical';

export interface RosskoLimiter {
  acquire(options: { priority: CallPriority; maxWaitMs?: number }): Promise<void>;
}

export function createRosskoLimiter(
  _redis: Redis,
  _options: { rpm: number; daily: number; breakerPct: number },
): RosskoLimiter {
  return notImplemented('createRosskoLimiter');
}

export interface SearchResult {
  offers: Offer[];
  fromCache: boolean;
}

export interface RosskoClient {
  search(
    text: string,
    options?: { priority?: CallPriority; bypassCache?: boolean },
  ): Promise<SearchResult>;
  checkoutDetails(): Promise<unknown>;
  orders(ids: readonly string[]): Promise<unknown>;
  /** Throws CheckoutDisabledError when allowCheckout is false. */
  checkout(request: unknown): Promise<unknown>;
}

export function createRosskoClient(_options: Record<string, unknown>): RosskoClient {
  return notImplemented('createRosskoClient');
}

export function mapSearchResult(
  _raw: unknown,
  _options: { localStockIds: readonly string[] },
): Offer[] {
  return notImplemented('mapSearchResult');
}

/** 'W 914/2' -> 'W9142' */
export function normalizeArticle(_value: string): string {
  return notImplemented('normalizeArticle');
}

/** '1234.50' -> 123450, without floating point. */
export function rubToKop(_value: string | number): number {
  return notImplemented('rubToKop');
}

export class CheckoutDisabledError extends Error {
  constructor() {
    super('Rossko checkout is disabled (ROSSKO_ALLOW_CHECKOUT=false)');
    this.name = 'CheckoutDisabledError';
  }
}

export class QuotaBreakerError extends Error {
  constructor(message = 'Rossko daily quota breaker is open') {
    super(message);
    this.name = 'QuotaBreakerError';
  }
}
