import type { Metadata } from 'next';
import { AdminPricing } from '@/components/admin/AdminPricing';
import { requireAdmin } from '@/server/admin/guard';
import { loadAdminPricing } from '@/server/admin/pricing';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Наценка по группам' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Step 2 (docs/pricing.md): group adjustments of the markup. */
export default async function AdminPricingPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const done = first(params.done)?.slice(0, 300) || null;
  let data;
  try {
    data = await loadAdminPricing(getDb(), serverEnv(), params, new Date());
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(error), 'admin pricing: database unavailable');
    throw new PageDataError('admin pricing: database unavailable');
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-bold">Наценка по группам</h1>
      <AdminPricing data={data} done={done} />
    </div>
  );
}
