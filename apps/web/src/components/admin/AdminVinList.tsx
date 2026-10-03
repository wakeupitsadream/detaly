import { VIN_REQUEST_STATUSES } from '@detaly/domain';
import Link from 'next/link';
import {
  VIN_OPEN_FILTER,
  VIN_STATUS_LABELS,
  type AdminVinList as AdminVinListData,
  type AdminVinQuery,
} from '@/server/admin/vin';
import { dateTime } from './format';

function listHref(query: AdminVinQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (page > 1) params.set('page', String(page));
  const text = params.toString();
  return text ? `/admin/vin?${text}` : '/admin/vin';
}

/** /admin/vin: VIN requests, newest first, with a status filter (decision С26). */
export function AdminVinList({ query, list }: { query: AdminVinQuery; list: AdminVinListData }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form
        method="get"
        action="/admin/vin"
        className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-card p-4"
        data-testid="admin-vin-filter"
      >
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="text-muted">Статус</span>
          <select
            name="status"
            defaultValue={query.status ?? ''}
            className="rounded-md border border-line bg-card px-2 py-2"
          >
            <option value="">Все заявки</option>
            <option value={VIN_OPEN_FILTER}>Ждут ответа</option>
            {VIN_REQUEST_STATUSES.map((status) => (
              <option key={status} value={status}>
                {VIN_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-strong"
        >
          Показать
        </button>
      </form>

      {list.rows.length === 0 ? (
        <p className="text-muted" data-testid="admin-vin-empty">
          Заявок нет.
        </p>
      ) : (
        <div className="min-w-0 overflow-x-auto rounded-card border border-line bg-card">
          <table
            className="w-full min-w-[44rem] text-left text-sm"
            data-testid="admin-vin-requests"
          >
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Заявка</th>
                <th className="px-3 py-2 font-medium">Статус</th>
                <th className="px-3 py-2 font-medium">VIN и авто</th>
                <th className="px-3 py-2 font-medium">Что нужно</th>
                <th className="px-3 py-2 font-medium">Телефон</th>
                <th className="px-3 py-2 font-medium">Создана</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-line last:border-0"
                  data-vin-request={row.id}
                  data-status={row.status}
                >
                  <td className="px-3 py-2 font-semibold whitespace-nowrap">
                    <Link href={`/admin/vin/${row.id}`} className="text-accent underline">
                      № {row.number}
                    </Link>
                    {row.photos > 0 ? (
                      <span className="block text-xs font-normal text-muted">
                        фото: {row.photos}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {VIN_STATUS_LABELS[row.status]}
                    {row.proposalCount > 1 ? (
                      <span className="block text-xs text-muted">
                        подборок: {row.proposalCount}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 wrap-anywhere">
                    <span className="font-mono">{row.vin ?? '—'}</span>
                    {row.carText ? <span className="block text-muted">{row.carText}</span> : null}
                  </td>
                  <td className="px-3 py-2 wrap-anywhere">{row.needShort}</td>
                  <td className="px-3 py-2 whitespace-nowrap">•••{row.phoneLast4}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{dateTime(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav className="flex gap-4 text-sm" aria-label="Страницы">
        {query.page > 1 ? (
          <Link href={listHref(query, query.page - 1)} className="text-accent underline">
            ← Новее
          </Link>
        ) : null}
        <span className="text-muted">Страница {query.page}</span>
        {list.hasNext ? (
          <Link href={listHref(query, query.page + 1)} className="text-accent underline">
            Старше →
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
