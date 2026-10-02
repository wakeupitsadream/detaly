// Admin card actions (docs/phase-1b-implementation.md 15.4). Basic auth is checked by
// src/proxy.ts and again in the handler; the engine acts as the owner (decision Б19).
import { handleAdminAction } from '@/server/admin/actions-handler';
import { getEngineDeps } from '@/server/engine';
import { getLogger } from '@/server/logger';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleAdminAction(request, id, { engine: getEngineDeps(), logger: getLogger() });
}
