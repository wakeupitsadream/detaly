import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AdminKitEditor } from '@/components/admin/AdminKits';
import { requireAdmin } from '@/server/admin/guard';
import {
  checkKitDraft,
  EMPTY_KIT_FORM,
  kitFormOf,
  kitFormValues,
  makeName,
  readKitDraft,
} from '@/server/admin/kits';
import { isUuid } from '@/server/admin/queries';
import { getDb } from '@/server/db';
import { errorInfo, PageDataError } from '@/server/errors';
import { loadKit, type KitRecord } from '@/server/kits/catalog';
import { getLogger } from '@/server/logger';
import { getSupplier } from '@/server/supplier';

export const metadata: Metadata = { title: 'Набор ТО' };

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Step 5 (docs/kits.md): the editor of a kit (`new` for a kit not saved yet). With `?check=1`
 * the fields come from the query (the «Проверить» GET or a refused save) and the draft is
 * checked at the supplier; otherwise the saved kit and the live check of its saved lines.
 */
export default async function AdminKitPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  await requireAdmin();
  const { id } = await params;
  const isNew = id === 'new';
  if (!isNew && !isUuid(id)) notFound();
  const query = await searchParams;
  const done = first(query.done)?.slice(0, 300) || null;
  const error = first(query.error)?.slice(0, 600) || null;
  const draftMode = first(query.check) === '1';

  let kit: KitRecord | null;
  try {
    kit = isNew ? null : await loadKit(getDb(), id);
  } catch (cause) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(cause), 'admin kit: database unavailable');
    throw new PageDataError('admin kit: database unavailable');
  }
  if (!isNew && kit === null) notFound();

  const values = draftMode
    ? kitFormValues((name) => first(query[name]))
    : kit
      ? kitFormOf(kit)
      : EMPTY_KIT_FORM;
  const now = new Date();
  const draft = readKitDraft(values, now);
  let check = null;
  if (draftMode || kit) {
    const supplier = getSupplier();
    check = await checkKitDraft(draft, {
      rossko: supplier.rossko,
      settings: await supplier.settings.get(),
      now,
    });
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-bold">
        {kit ? `Набор: ${makeName(kit.makeSlug)} ${kit.model}` : 'Новый набор'}
      </h1>
      <AdminKitEditor
        kit={kit}
        values={values}
        fieldErrors={draftMode ? draft.fieldErrors : {}}
        check={check}
        draftMode={draftMode}
        done={done}
        error={error}
      />
    </div>
  );
}
