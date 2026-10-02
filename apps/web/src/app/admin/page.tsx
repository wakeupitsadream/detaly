import type { Metadata } from 'next';
import { AdminOrderList } from '@/components/admin/AdminOrderList';
import { requireAdmin } from '@/server/admin/guard';
import { listAdminOrders, parseAdminListQuery } from '@/server/admin/queries';
import { getDb } from '@/server/db';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Заказы' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AdminOrdersPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const query = parseAdminListQuery(await searchParams);
  let list;
  try {
    list = await listAdminOrders(getDb(), query);
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters (phone digits).
    getLogger().error(errorInfo(error), 'admin list: database unavailable');
    throw new PageDataError('admin list: database unavailable');
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-bold">Заказы</h1>
      <AdminOrderList query={query} list={list} />
    </div>
  );
}
