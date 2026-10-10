import type { Metadata } from 'next';
import { AdminAutoOrder } from '@/components/admin/AdminAutoOrder';
import { loadAdminAutoOrder } from '@/server/admin/auto-order';
import { requireAdmin } from '@/server/admin/guard';
import { getDb } from '@/server/db';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Теневой автозаказ' };

/**
 * Step 8 (docs/rossko-automation.md): the shadow auto-order statistics of 30 and 90 days and the
 * verdict. Read-only: there is no switch of the real auto-order.
 */
export default async function AdminAutoOrderPage() {
  await requireAdmin();
  let data;
  try {
    data = await loadAdminAutoOrder(getDb(), new Date());
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(error), 'admin auto-order: database unavailable');
    throw new PageDataError('admin auto-order: database unavailable');
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-bold">Теневой автозаказ</h1>
      <AdminAutoOrder data={data} />
    </div>
  );
}
