import { ORDER_STATUSES } from '@detaly/domain';
import Link from 'next/link';
import {
  ADMIN_EXTRA_FILTER_LABELS,
  ADMIN_EXTRA_FILTERS,
  type AdminListQuery,
  type AdminOrderList as AdminOrderListData,
} from '@/server/admin/queries';
import { adminStatusLabel, attentionLabel, dateTime, isoDate, rub, SCHEME_LABELS } from './format';

function listHref(query: AdminListQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.q) params.set('q', query.q);
  if (page > 1) params.set('page', String(page));
  const text = params.toString();
  return text ? `/admin?${text}` : '/admin';
}

export function AdminOrderList({
  query,
  list,
}: {
  query: AdminListQuery;
  list: AdminOrderListData;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form
        method="get"
        action="/admin"
        className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-card p-4"
        data-testid="admin-filter"
      >
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="text-muted">Статус</span>
          <select
            name="status"
            defaultValue={query.status ?? ''}
            className="rounded-md border border-line bg-card px-2 py-2"
          >
            <option value="">Все заказы</option>
            {ADMIN_EXTRA_FILTERS.map((filter) => (
              <option key={filter} value={filter}>
                {ADMIN_EXTRA_FILTER_LABELS[filter]}
              </option>
            ))}
            {ORDER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {adminStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="text-muted">Номер DT-… или 4 последние цифры телефона</span>
          <input
            type="search"
            name="q"
            defaultValue={query.q}
            maxLength={32}
            inputMode="text"
            autoComplete="off"
            className="w-56 max-w-full rounded-md border border-line px-2 py-2"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-strong"
        >
          Показать
        </button>
      </form>

      {list.invalidSearch ? (
        <p className="text-warn" data-testid="admin-search-invalid">
          Ищите по номеру заказа (DT-000123) или по 4 последним цифрам телефона.
        </p>
      ) : null}

      {list.rows.length === 0 ? (
        <p className="text-muted" data-testid="admin-empty">
          Заказов нет.
        </p>
      ) : (
        <div className="min-w-0 overflow-x-auto rounded-card border border-line bg-card">
          <table className="w-full text-left text-sm" data-testid="admin-orders">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Номер</th>
                <th className="px-3 py-2 font-medium">Статус</th>
                <th className="px-3 py-2 font-medium">Схема</th>
                <th className="px-3 py-2 text-right font-medium">Сумма</th>
                <th className="px-3 py-2 font-medium">Дата</th>
                <th className="px-3 py-2 font-medium">Создан</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-line last:border-0"
                  data-order={row.number}
                >
                  <td className="px-3 py-2 font-semibold whitespace-nowrap">
                    <Link href={`/admin/orders/${row.id}`} className="text-accent underline">
                      {row.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {adminStatusLabel(row.status)}
                    {row.status === 'needs_attention' && row.attentionReason ? (
                      <span className="block text-xs text-warn">
                        {attentionLabel(row.attentionReason)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{SCHEME_LABELS[row.scheme]}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{rub(row.totalKop)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{isoDate(row.promisedDate)}</td>
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
