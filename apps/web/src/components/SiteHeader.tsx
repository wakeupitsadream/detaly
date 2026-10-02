import Link from 'next/link';

const NAV = [
  { href: '/vin', label: 'Подбор по VIN' },
  { href: '/returns', label: 'Возврат' },
  { href: '/about', label: 'О нас' },
];

/** "3 позиции" for the cart link's accessible name. */
export function cartCountLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'позиция'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'позиции'
        : 'позиций';
  return `${count} ${word}`;
}

export function SiteHeader({ brandName, cartCount }: { brandName: string; cartCount: number }) {
  return (
    <header className="border-b border-line bg-card">
      <div className="mx-auto flex max-w-5xl min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="min-w-0 text-xl font-bold tracking-tight wrap-anywhere">
          {brandName}
        </Link>
        <nav aria-label="Основное меню" className="min-w-0">
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="text-muted hover:text-ink">
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              {/* No prefetch: opening the cart re-prices it at the supplier. */}
              <Link
                href="/cart"
                prefetch={false}
                className="inline-flex min-h-11 items-center gap-1.5 font-medium text-ink hover:text-accent"
                aria-label={
                  cartCount > 0 ? `Корзина: ${cartCountLabel(cartCount)}` : 'Корзина пуста'
                }
                data-testid="header-cart"
              >
                Корзина
                {cartCount > 0 ? (
                  <span
                    className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold text-white"
                    data-testid="header-cart-count"
                  >
                    {cartCount}
                  </span>
                ) : null}
              </Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
