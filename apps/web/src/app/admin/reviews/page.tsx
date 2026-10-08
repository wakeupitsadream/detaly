import type { Metadata } from 'next';
import { AdminReviews } from '@/components/admin/AdminReviews';
import { requireAdmin } from '@/server/admin/guard';
import { loadAdminReviews } from '@/server/admin/reviews';
import { getDb } from '@/server/db';
import { serverEnv } from '@/server/env';
import { errorInfo, PageDataError } from '@/server/errors';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Отзывы' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Step 3 (docs/reviews.md): review links, the rating snapshot, the funnel and the sign. */
export default async function AdminReviewsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAdmin();
  const params = await searchParams;
  const done = first(params.done)?.slice(0, 300) || null;
  let data;
  try {
    data = await loadAdminReviews(getDb(), serverEnv(), new Date());
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    getLogger().error(errorInfo(error), 'admin reviews: database unavailable');
    throw new PageDataError('admin reviews: database unavailable');
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="text-2xl font-bold">Отзывы</h1>
      <AdminReviews data={data} done={done} />
    </div>
  );
}
