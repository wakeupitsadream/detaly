/**
 * Wiring of the search service with real dependencies (lazy singletons). The supplier side
 * (Rossko client, limiter, settings) is the shared one from server/supplier.ts. Tests build
 * their own with createSearchDeps and a key prefix.
 */
import type { Env, Redis } from '@detaly/config';
import { searchLog, type Database } from '@detaly/db';
import type { RosskoCaller } from '@detaly/rossko';
import { getDb } from './db';
import { singleton } from './globals';
import { isDemoMode } from './mode';
import { createSearchService, type SearchService, type SearchServiceDeps } from './search-service';
import { createSupplierDeps, getSupplier, logSupplierError, type Supplier } from './supplier';

export interface SearchDepsOptions {
  env: Env;
  db: Database;
  redis: Redis;
  keyPrefix?: string;
  caller?: RosskoCaller;
  onError?: (error: unknown, what: string) => void;
}

/** Search dependencies on top of existing supplier dependencies. */
export function searchDepsFromSupplier(
  supplier: Supplier,
  db: Database,
  onError?: (error: unknown, what: string) => void,
): SearchServiceDeps {
  return {
    rossko: supplier.rossko,
    limiter: supplier.limiter,
    loadSettings: () => supplier.settings.get(),
    logSearch: (row) => db.insert(searchLog).values(row),
    onBackgroundError: onError,
  };
}

export function createSearchDeps(options: SearchDepsOptions): SearchServiceDeps {
  return searchDepsFromSupplier(createSupplierDeps(options), options.db, options.onError);
}

/**
 * DEMO_MODE: the same service over the demo supplier, without `search_log` (no database).
 */
export function demoSearchDeps(supplier: Supplier, onError?: SearchDepsOptions['onError']) {
  return {
    rossko: supplier.rossko,
    limiter: supplier.limiter,
    loadSettings: () => supplier.settings.get(),
    onBackgroundError: onError,
  } satisfies SearchServiceDeps;
}

export function getSearchService(): SearchService {
  if (isDemoMode()) {
    return singleton('demo-search-service', () =>
      createSearchService(demoSearchDeps(getSupplier(), logSupplierError)),
    );
  }
  return singleton('search-service', () =>
    createSearchService(searchDepsFromSupplier(getSupplier(), getDb(), logSupplierError)),
  );
}
