/**
 * Building blocks of the step 7 admin pages (/admin/month, its act and rates, /admin/returns,
 * /admin/stock): a section card, a notice, a table that scrolls inside its card on a phone
 * (never the page), money in integer kopecks with the sign.
 */
import { formatRubSigned } from '@detaly/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const BUTTON =
  'inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50';
export const SECONDARY =
  'inline-flex min-h-11 items-center justify-center rounded-md border border-line-strong bg-card px-4 py-2 font-semibold hover:border-ink';
export const INPUT =
  'min-w-0 rounded-md border border-line-strong bg-card px-2 py-2 tabular-nums placeholder:text-faint';

export function Section({
  title,
  children,
  testId,
  aside,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
  /** Links or a note at the right of the title. */
  aside?: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-card border border-line bg-card p-4" data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {aside ? <div className="text-sm">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Notice({
  tone,
  children,
  testId,
  printHide = false,
}: {
  tone: 'warn' | 'ok' | 'info' | 'danger';
  children: ReactNode;
  testId?: string;
  /** Screen only: hidden on paper (data-print-hide). */
  printHide?: boolean;
}) {
  const colors = {
    warn: 'border-warn bg-warn-soft text-warn',
    ok: 'border-local bg-local-soft text-local',
    info: 'border-order bg-order-soft text-order',
    danger: 'border-danger bg-danger-soft text-danger',
  }[tone];
  return (
    <div
      className={`rounded-card border px-4 py-2 text-sm ${colors}`}
      role={tone === 'ok' ? 'status' : undefined}
      data-testid={testId}
      data-print-hide={printHide ? true : undefined}
    >
      {children}
    </div>
  );
}

export function Done({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      className="rounded-card border border-local bg-local-soft px-4 py-2 text-local"
      role="status"
      data-testid="admin-done"
    >
      {message}
    </p>
  );
}

/** Classes of a column a phone does not show: its value is repeated under the first cell. */
export const DESKTOP_CELL = 'hidden sm:table-cell';

/** A line under the first cell that only a phone shows (the values of the hidden columns). */
export function PhoneLine({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 block text-xs text-muted sm:hidden">{children}</span>;
}

/**
 * A table that fits its card: no forced width, long texts wrap, amounts stay on one line. Columns
 * listed in `desktop` are hidden on a phone (their values go into a PhoneLine of the first cell);
 * a table that still does not fit scrolls inside its card, never the page.
 */
export function DataTable({
  head,
  children,
  testId,
  numeric = [],
  desktop = [],
}: {
  head: string[];
  children: ReactNode;
  testId?: string;
  /** Column indexes aligned right (amounts, counts). */
  numeric?: number[];
  /** Column indexes shown from `sm` only. */
  desktop?: number[];
}) {
  return (
    <div className="min-w-0 overflow-x-auto" data-testid={testId}>
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-muted">
          <tr>
            {head.map((title, index) => (
              <th
                key={title}
                className={[
                  'px-2 py-1.5 font-medium whitespace-nowrap',
                  numeric.includes(index) ? 'text-right' : null,
                  desktop.includes(index) ? DESKTOP_CELL : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  className = '',
  numeric = false,
  desktop = false,
}: {
  children?: ReactNode;
  className?: string;
  numeric?: boolean;
  /** Shown from `sm` only (a column listed in the table's `desktop`). */
  desktop?: boolean;
}) {
  return (
    <td
      className={[
        'px-2 py-1.5 align-top',
        numeric ? 'text-right whitespace-nowrap tabular-nums' : null,
        desktop ? DESKTOP_CELL : null,
        className || null,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </td>
  );
}

/** Kopecks with the sign: «−1 234,50 ₽» in the danger colour when below zero. */
export function Money({ kop, strong = false }: { kop: number; strong?: boolean }) {
  const classes = ['whitespace-nowrap tabular-nums', kop < 0 ? 'text-danger' : null];
  if (strong) classes.push('font-semibold');
  return <span className={classes.filter(Boolean).join(' ')}>{formatRubSigned(kop)}</span>;
}

/** «Заказ DT-000123» linking to the order card. */
export function OrderLink({ orderId, number }: { orderId: string; number: string }) {
  return (
    <Link href={`/admin/orders/${orderId}`} className="whitespace-nowrap text-accent underline">
      {number}
    </Link>
  );
}

/** '2026-09-30' -> '30.09.2026'. */
export function shortDate(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
}
