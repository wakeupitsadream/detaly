/**
 * GetSearch cache in Redis: `rossko:search:v2:<articleNorm>:<deliveryId>`, TTL 900 s.
 * Empty results ("nothing found") are cached too, so repeated junk queries cost nothing;
 * a supplier error reported as success:false is kept only SEARCH_ERROR_CACHE_TTL_SEC.
 * Bump the version when the cached shape (Offer) changes (v2: deliveryDays may be null).
 */
import type { Offer } from '@detaly/domain/types';
import type { Redis } from 'ioredis';

export const SEARCH_CACHE_TTL_SEC = 900;
/** success:false with an unknown message (bad keys, supplier trouble): retry soon. */
export const SEARCH_ERROR_CACHE_TTL_SEC = 60;

export interface CachedSearch {
  offers: Offer[];
  message: string | null;
  /** ISO instant of the supplier answer. */
  fetchedAt: string;
}

export interface SearchCache {
  key(articleNorm: string, deliveryId: string | null): string;
  get(key: string): Promise<CachedSearch | null>;
  /** `ttlSec` overrides the cache TTL for this entry (short-lived supplier errors). */
  set(key: string, value: CachedSearch, ttlSec?: number): Promise<void>;
}

export interface SearchCacheOptions {
  ttlSec?: number;
  /** Prepended to every key; tests use `test:<uuid>:`. Default ''. */
  keyPrefix?: string;
}

function isCachedSearch(value: unknown): value is CachedSearch {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.offers) && typeof v.fetchedAt === 'string';
}

export function createSearchCache(redis: Redis, options: SearchCacheOptions = {}): SearchCache {
  const ttlSec = options.ttlSec ?? SEARCH_CACHE_TTL_SEC;
  const prefix = options.keyPrefix ?? '';
  return {
    key(articleNorm, deliveryId) {
      return `${prefix}rossko:search:v2:${articleNorm}:${deliveryId ?? '-'}`;
    },
    async get(key) {
      const raw = await redis.get(key);
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isCachedSearch(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async set(key, value, entryTtlSec) {
      await redis.set(key, JSON.stringify(value), 'EX', entryTtlSec ?? ttlSec);
    },
  };
}
