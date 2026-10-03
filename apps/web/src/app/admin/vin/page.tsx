import type { Metadata } from 'next';
import { AdminVinList } from '@/components/admin/AdminVinList';
import { requireAdmin } from '@/server/admin/guard';
import { listAdminVinRequests, parseAdminVinQuery } from '@/server/admin/vin';
import { getDb } from '@/server/db';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Заявки VIN' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AdminVinRequestsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireAdmin();
  const query = parseAdminVinQuery(await searchParams);
  let list;
  try {
    list = await listAdminVinRequests(getDb(), query);
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(error), 'admin vin list: database unavailable');
    throw new PageDataError('admin vin list: database unavailable');
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-bold">Заявки VIN</h1>
      <AdminVinList query={query} list={list} />
    </div>
  );
}
