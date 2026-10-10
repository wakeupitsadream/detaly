import { listStockItems } from '@detaly/orders';
import type { Metadata } from 'next';
import { AdminStock } from '@/components/admin/AdminReturns';
import { requireAdmin } from '@/server/admin/guard';
import { getDb } from '@/server/db';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Склад' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Step 7 (docs/month-close.md): parts Rossko did not take back, with «Списать». */
export default async function AdminStockPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const done = first(params.done)?.slice(0, 300) || null;
  let items;
  try {
    items = await listStockItems(getDb(), { includeWrittenOff: true });
  } catch (error) {
    getLogger().error(errorInfo(error), 'admin stock: database unavailable');
    throw new PageDataError('admin stock: database unavailable');
  }
  return <AdminStock items={items} done={done} />;
}
