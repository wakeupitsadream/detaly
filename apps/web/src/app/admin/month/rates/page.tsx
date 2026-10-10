import type { Metadata } from 'next';
import { AdminRates } from '@/components/admin/AdminRates';
import { requireAdmin } from '@/server/admin/guard';
import { loadAdminRates, parseMonthParam } from '@/server/admin/month';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Ставки договора' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Step 7 (docs/month-close.md): the contract rates of the pickup point with the act preview. */
export default async function AdminRatesPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const done = first(params.done)?.slice(0, 300) || null;
  const now = new Date();
  const month = parseMonthParam(params.m, now);
  let data;
  try {
    data = await loadAdminRates(getDb(), serverEnv(), month, params, now);
  } catch (error) {
    getLogger().error(errorInfo(error), 'admin rates: database unavailable');
    throw new PageDataError('admin rates: database unavailable');
  }
  return <AdminRates data={data} done={done} />;
}
