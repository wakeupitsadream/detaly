import type { Metadata } from 'next';
import { AdminPrices } from '@/components/admin/AdminPrices';
import { requireAdmin } from '@/server/admin/guard';
import { loadAdminPrices, parseAdminPricesQuery } from '@/server/admin/prices';
import { getDb } from '@/server/db';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';
import { getSupplier } from '@/server/supplier';

export const metadata: Metadata = { title: 'Цены' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Step 2 (docs/pricing.md): the internal price benchmark. */
export default async function AdminPricesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const query = parseAdminPricesQuery(params);
  const done = first(params.done)?.slice(0, 300) || null;
  let data;
  let pricing;
  try {
    pricing = (await getSupplier().settings.get()).pricing;
    data = await loadAdminPrices(getDb(), query, pricing, new Date());
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(error), 'admin prices: database unavailable');
    throw new PageDataError('admin prices: database unavailable');
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-bold">Сравнение цен</h1>
      <AdminPrices query={query} data={data} pricing={pricing} done={done} />
    </div>
  );
}
