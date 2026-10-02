/** GET /api/health: 200 when Postgres, Redis and the worker heartbeat are fine, else 503. */
import { computeHealth, type HealthDeps } from '../health';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function handleHealthRequest(deps: () => HealthDeps): Promise<Response> {
  let resolved: HealthDeps;
  try {
    resolved = deps();
  } catch {
    // Invalid env or a client that cannot even be created.
    return Response.json({ ok: false, error: 'config' }, { status: 503, headers: NO_STORE });
  }
  const report = await computeHealth(resolved);
  return Response.json(report, { status: report.ok ? 200 : 503, headers: NO_STORE });
}
