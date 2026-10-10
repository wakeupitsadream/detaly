import type { Metadata } from 'next';
import { AdminMonth } from '@/components/admin/AdminMonth';
import { requireAdmin } from '@/server/admin/guard';
import { actContractFromEnv, loadAdminMonth, parseMonthParam } from '@/server/admin/month';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';
import { getPayments } from '@/server/payments/provider';

export const metadata: Metadata = { title: 'Закрытие месяца' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Step 7 (docs/month-close.md): the close of a month, `?m=YYYY-MM` (the previous by default). */
export default async function AdminMonthPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const done = first(params.done)?.slice(0, 300) || null;
  const env = serverEnv();
  const now = new Date();
  const month = parseMonthParam(params.m, now);
  let data;
  try {
    data = await loadAdminMonth(getDb(), env, month, now, getPayments() !== null);
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(error), 'admin month: database unavailable');
    throw new PageDataError('admin month: database unavailable');
  }
  return <AdminMonth data={data} done={done} contractMissing={actContractFromEnv(env).missing} />;
}
