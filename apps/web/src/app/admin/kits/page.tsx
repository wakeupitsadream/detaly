import type { Metadata } from 'next';
import { AdminKitList } from '@/components/admin/AdminKits';
import { requireAdmin } from '@/server/admin/guard';
import { loadAdminKits } from '@/server/admin/kits';
import { getDb } from '@/server/db';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Наборы ТО' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Step 5 (docs/kits.md): the maintenance kits by car model. */
export default async function AdminKitsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const done = first(params.done)?.slice(0, 300) || null;
  let rows;
  try {
    rows = await loadAdminKits(getDb());
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(error), 'admin kits: database unavailable');
    throw new PageDataError('admin kits: database unavailable');
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-bold">Наборы ТО</h1>
      <AdminKitList rows={rows} done={done} />
    </div>
  );
}
