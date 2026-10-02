import Link from 'next/link';

const NAV = [
  { href: '/vin', label: 'Подбор по VIN' },
  { href: '/returns', label: 'Возврат' },
  { href: '/about', label: 'О нас' },
];

export function SiteHeader({ brandName }: { brandName: string }) {
  return (
    <header className="border-b border-line bg-card">
      <div className="mx-auto flex max-w-5xl min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="min-w-0 text-xl font-bold tracking-tight wrap-anywhere">
          {brandName}
        </Link>
        <nav aria-label="Основное меню" className="min-w-0">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="text-muted hover:text-ink">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
