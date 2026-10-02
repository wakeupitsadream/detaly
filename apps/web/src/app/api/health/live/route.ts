// Liveness for the Docker healthcheck only: the process answers HTTP. It checks nothing
// else, so a dead worker or database never makes Docker restart web (see /api/health).
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}
