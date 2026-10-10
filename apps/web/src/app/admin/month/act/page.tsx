import { monthTitle } from '@detaly/domain';
import { loadMonthReport } from '@detaly/orders';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AdminAct } from '@/components/admin/AdminAct';
import { Notice, BUTTON, SECONDARY } from '@/components/admin/finance-ui';
import { PrintButton } from '@/components/admin/PrintButton';
import { requireAdmin } from '@/server/admin/guard';
import { actContractFromEnv, parseMonthParam } from '@/server/admin/month';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Акт для пункта выдачи' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * /admin/month/act?m=YYYY-MM (step 7, docs/month-close.md): the printable A4 act of the pickup
 * point's services. The controls and the warnings are not printed (data-print-hide).
 */
export default async function AdminActPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const env = serverEnv();
  const now = new Date();
  const month = parseMonthParam(params.m, now);
  let report;
  try {
    report = await loadMonthReport(getDb(), env, month, now);
  } catch (error) {
    getLogger().error(errorInfo(error), 'admin act: database unavailable');
    throw new PageDataError('admin act: database unavailable');
  }
  const contract = actContractFromEnv(env);
  const { summary } = report.act;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-3" data-print-hide>
        <h1 className="text-2xl font-bold">Акт за {monthTitle(month)}</h1>
        {!summary.ratesSet ? (
          <Notice tone="warn" testId="act-rates-unset">
            Ставки не заданы: в акте операции с ценой 0 ₽.{' '}
            <Link href={`/admin/month/rates?m=${month}`} className="underline">
              Задать ставки договора
            </Link>
          </Notice>
        ) : null}
        {contract.missing.length > 0 ? (
          <Notice tone="info" testId="act-contract-missing">
            Не заданы в env: {contract.missing.join(', ')} — в акте пустые строки, их можно
            заполнить от руки.
          </Notice>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <PrintButton className={BUTTON} />
          <a
            href={`/api/admin/month/csv?m=${month}`}
            download={`act-${month}.csv`}
            className={SECONDARY}
          >
            Скачать CSV
          </a>
          <Link href={`/admin/month?m=${month}`} className={SECONDARY}>
            К закрытию месяца
          </Link>
        </div>
      </div>
      <AdminAct month={month} bounds={report.bounds} act={summary} contract={contract} />
    </div>
  );
}
