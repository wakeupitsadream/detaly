import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getBrand } from '@/server/brand';
import { isDemoMode } from '@/server/mode';

// Reads env, the database and the request headers on every request (Basic auth, decision Б25).
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return {
    title: `Админка — ${getBrand().name}`,
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

/** The admin's own frame: no site header, footer or cart (the root layout stays as is). */
export default function AdminLayout({ children }: { children: ReactNode }) {
  // DEMO_MODE has no admin at all (src/proxy.ts answers 404 before this).
  if (isDemoMode()) notFound();
  return (
    <div className="flex min-h-screen min-w-0 flex-col">
      <header className="border-b border-line bg-card" data-print-hide>
        <nav
          className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
          aria-label="Разделы админки"
          data-testid="admin-nav"
        >
          <Link href="/admin" className="font-bold">
            Админка
          </Link>
          <Link href="/admin" className="text-sm text-accent underline">
            Заказы
          </Link>
          <Link href="/admin/vin" className="text-sm text-accent underline">
            Заявки VIN
          </Link>
          <Link href="/admin?status=attention" className="text-sm text-accent underline">
            Требуют внимания
          </Link>
          <Link href="/admin?status=claims_open" className="text-sm text-accent underline">
            Претензии
          </Link>
          <Link href="/admin?status=install_requested" className="text-sm text-accent underline">
            Записи
          </Link>
          <Link href="/admin/prices" className="text-sm text-accent underline">
            Цены
          </Link>
          <Link href="/admin/pricing" className="text-sm text-accent underline">
            Наценка
          </Link>
          <Link href="/admin/reviews" className="text-sm text-accent underline">
            Отзывы
          </Link>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl min-w-0 flex-1 px-4 py-6 print:max-w-none print:p-0">
        {children}
      </main>
    </div>
  );
}
