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
