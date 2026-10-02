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

export function getSearchService(): SearchService {
  return singleton('search-service', () =>
    createSearchService(searchDepsFromSupplier(getSupplier(), getDb(), logSupplierError)),
  );
}
