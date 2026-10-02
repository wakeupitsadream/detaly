/**
 * The one switch of the server layer: DEMO_MODE=true runs the storefront without Postgres and
 * Redis (docs/design.md, section 5). Factories pick their implementation by this flag inside
 * themselves. Read from process.env directly for now; package P3 moves it into the env schema.
 */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === 'true';
}
