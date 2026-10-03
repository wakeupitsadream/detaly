import type { EtaSettings } from '@detaly/domain';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AdminVinCard } from '@/components/admin/AdminVinCard';
import { requireAdmin } from '@/server/admin/guard';
import { isUuid } from '@/server/admin/queries';
import { loadAdminVinRequest } from '@/server/admin/vin';
import { getDb } from '@/server/db';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';
import { getSupplier } from '@/server/supplier';

export const metadata: Metadata = { title: 'Заявка VIN' };

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminVinRequestPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  await requireAdmin();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const query = await searchParams;
  const done = first(query.done)?.slice(0, 300) || null;
  const edit = first(query.edit) === '1';

  let card;
  let eta: EtaSettings;
  try {
    card = await loadAdminVinRequest(getDb(), id);
    eta = (await getSupplier().settings.get()).eta;
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(error), 'admin vin request: database unavailable');
    throw new PageDataError('admin vin request: database unavailable');
  }
  if (card === null) notFound();
  return <AdminVinCard card={card} done={done} edit={edit} eta={eta} />;
}
