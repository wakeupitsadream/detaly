import { listSupplierReturns } from '@detaly/orders';
import type { Metadata } from 'next';
import { AdminReturns } from '@/components/admin/AdminReturns';
import { requireAdmin } from '@/server/admin/guard';
import { getDb } from '@/server/db';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Возвраты поставщику' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Closed returns stay on the page this long. */
const CLOSED_DAYS = 30;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Step 7 (docs/month-close.md): the parts going back to Rossko, the overdue ones first. */
export default async function AdminReturnsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const done = first(params.done)?.slice(0, 300) || null;
  const now = new Date();
  let returns;
  try {
    returns = await listSupplierReturns(getDb(), {
      now,
      closedSince: new Date(now.getTime() - CLOSED_DAYS * 24 * 60 * 60 * 1000),
    });
  } catch (error) {
    getLogger().error(errorInfo(error), 'admin returns: database unavailable');
    throw new PageDataError('admin returns: database unavailable');
  }
  return <AdminReturns returns={returns} now={now} done={done} />;
}
