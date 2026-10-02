/**
 * Cross-bundle error matching.
 *
 * Next bundles each page and route handler separately, and every bundle gets its own copy of
 * the workspace packages (transpilePackages) and of these server modules. The services are
 * process-wide singletons (server/globals.ts) created by whichever bundle ran first, so an
 * error thrown inside a singleton may be an instance of another bundle's copy of the class and
 * `instanceof` alone fails (for example /api/search answered 500 instead of 400 after /search
 * had created the search service). Such errors are matched by their `name` as well.
 */
export function isNamedError<T extends Error>(
  error: unknown,
  ctor: abstract new (...args: never[]) => T,
  name: string,
): error is T {
  return error instanceof ctor || (error instanceof Error && error.name === name);
}

/** postgres-js error (code, constraint) found in a drizzle error's cause chain. */
export function pgErrorOf(error: unknown): { code?: string; constraint_name?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      return current as { code?: string; constraint_name?: string };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Log-safe description of an unexpected error: names and SQLSTATE only, never a message.
 * DrizzleQueryError (drizzle-orm 0.45, `name` 'Error') puts the query and its parameters into
 * `message` ("Failed query: … params: …"), so a lookup by an order or cart token would write
 * that bearer secret to the log; for such an error the driver error's name is used instead.
 */
export function errorInfo(error: unknown): Record<string, unknown> {
  const pg = pgErrorOf(error);
  const base =
    error instanceof Error && 'params' in error && error.cause instanceof Error
      ? error.cause
      : error;
  return {
    err: base instanceof Error ? base.name : typeof base,
    ...(typeof pg?.code === 'string' ? { pgCode: pg.code } : {}),
    ...(typeof pg?.constraint_name === 'string' ? { constraint: pg.constraint_name } : {}),
  };
}

/**
 * What a page throws after logging errorInfo: Next prints an unhandled render error with its
 * message, and a driver message may carry the token from the URL or the cookie.
 */
export class PageDataError extends Error {
  override name = 'PageDataError';
}
