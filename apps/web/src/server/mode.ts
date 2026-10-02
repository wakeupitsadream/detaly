/**
 * The one switch of the server layer: DEMO_MODE=true runs the storefront without Postgres and
 * Redis (docs/design.md, section 5). Factories (getSupplier, getSearchService, getCartService,
 * requestCartCount, loadPublishedDocument, currentCheckoutGate, health) pick their
 * implementation by this flag inside themselves; the live implementations are untouched.
 */
import { serverEnv } from './env';

/** Same spellings z.stringbool() accepts as true. */
const TRUE_RE = /^(?:true|1|yes|on|y|enabled)$/i;

/** The raw DEMO_MODE value as the env schema would read it (for an env that fails to parse). */
export function rawDemoFlag(value: string | undefined = process.env.DEMO_MODE): boolean {
  return TRUE_RE.test((value ?? '').trim());
}

export function isDemoMode(): boolean {
  try {
    return serverEnv().DEMO_MODE;
  } catch {
    // Invalid env (the page reports it itself): still honour the raw flag, so a demo with a
    // typo elsewhere never falls through to the database.
    return rawDemoFlag();
  }
}

/**
 * Thrown by getDb() and getRedis() in the demo: any path that still reaches for the database
 * or Redis shows up in the log at once instead of hanging on a connection.
 */
export class DemoModeError extends Error {
  override name = 'DemoModeError';

  constructor(what: string) {
    super(`${what} is not available in DEMO_MODE`);
  }
}
