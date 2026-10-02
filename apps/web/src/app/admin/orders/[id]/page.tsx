import { localDate } from '@detaly/domain';
import { loadStaffActions } from '@detaly/orders';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AdminOrderCard } from '@/components/admin/AdminOrderCard';
import { requireAdmin } from '@/server/admin/guard';
import { handoverQr } from '@/server/admin/handover-qr';
import { isUuid, loadAdminOrder } from '@/server/admin/queries';
import { getEngineDeps } from '@/server/engine';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Заказ' };

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AdminOrderPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  await requireAdmin();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const doneRaw = (await searchParams).done;
  const done = (Array.isArray(doneRaw) ? doneRaw[0] : doneRaw)?.slice(0, 300) || null;

  const deps = getEngineDeps();
  let data;
  try {
    const [card, actions] = await Promise.all([
      loadAdminOrder(deps.db, id),
      loadStaffActions(deps, id, 'owner'),
    ]);
    data = card && actions ? { card, actions, qr: await handoverQr(card) } : null;
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(error), 'admin order: database unavailable');
    throw new PageDataError('admin order: database unavailable');
  }
  if (data === null) notFound();

  return (
    <AdminOrderCard
      card={data.card}
      actions={data.actions}
      done={done}
      qr={data.qr}
      today={localDate(new Date())}
    />
  );
}
