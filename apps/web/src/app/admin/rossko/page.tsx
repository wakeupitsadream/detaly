import type { Metadata } from 'next';
import { AdminRossko } from '@/components/admin/AdminRossko';
import { requireAdmin } from '@/server/admin/guard';
import { loadAdminRossko } from '@/server/admin/rossko';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Rossko' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Step 8 (docs/rossko-automation.md): the GetOrders status map, the polling switch, the order
 * deadline, the cutoff times and the shadow auto-order limit.
 */
export default async function AdminRosskoPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const done = first(params.done)?.slice(0, 300) || null;
  let data;
  try {
    data = await loadAdminRossko(getDb(), serverEnv());
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(error), 'admin rossko: database unavailable');
    throw new PageDataError('admin rossko: database unavailable');
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-bold">Rossko без личного кабинета</h1>
      <AdminRossko data={data} done={done} />
    </div>
  );
}
