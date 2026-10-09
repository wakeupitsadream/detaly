import type { Metadata } from 'next';
import { AdminFitChecks } from '@/components/admin/AdminFitChecks';
import { loadAdminFitChecks } from '@/server/admin/fit-checks';
import { requireAdmin } from '@/server/admin/guard';
import { getDb } from '@/server/db';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';
import { getSupplier } from '@/server/supplier';

export const metadata: Metadata = { title: 'Проверки применимости' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Step 4 (docs/fit-check.md): fit check requests, the statistics and the SLA. */
export default async function AdminFitChecksPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const done = first(params.done)?.slice(0, 300) || null;
  let data;
  try {
    const settings = await getSupplier().settings.get();
    data = await loadAdminFitChecks(getDb(), {
      now: new Date(),
      schedule: settings.eta.pickupSchedule ?? null,
    });
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(error), 'admin fit checks: database unavailable');
    throw new PageDataError('admin fit checks: database unavailable');
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-bold">Проверки применимости</h1>
      <AdminFitChecks data={data} done={done} />
    </div>
  );
}
