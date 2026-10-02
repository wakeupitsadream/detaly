/**
 * Next.js calls register() once per server process at startup. Only the Node runtime runs
 * the checks; env and the logger are loaded lazily so `next build` needs no runtime env.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const [{ serverEnv }, { getLogger }, { logStartupWarnings }] = await Promise.all([
      import('./server/env'),
      import('./server/logger'),
      import('./server/startup-checks'),
    ]);
    logStartupWarnings(serverEnv(), getLogger());
  } catch (error) {
    // An invalid env fails the first request with a clear error; startup checks never crash.
    console.warn('startup checks skipped:', error instanceof Error ? error.message : 'unknown');
  }
}
