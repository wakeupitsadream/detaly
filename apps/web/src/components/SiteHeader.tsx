import Link from 'next/link';
import { cartCountLabel } from '@/lib/plural';
import { HeaderSearch } from './HeaderSearch';
import { IconCart } from './icons';
import { BrandMark } from './ui/BrandMark';
import { Container } from './ui/Container';

export { cartCountLabel };

const NAV = [
  { href: '/vin', label: 'Подбор по VIN' },
  { href: '/returns', label: 'Возврат' },
  { href: '/about', label: 'О нас' },
];

/**
 * Graphite header, sticky from md. Phones: logo and cart on the first row, the navigation as a
 * scrolling row below (never a burger: e2e looks for «О нас» in «Основное меню» on 375 px).
 * Desktop: logo, compact search on inner pages, navigation, cart.
 */
export function SiteHeader({ brandName, cartCount }: { brandName: string; cartCount: number }) {
  return (
    <header className="site-header relative z-30 border-b border-graphite-700 bg-graphite-950 text-paper md:sticky md:top-0">
      <Container className="flex flex-wrap items-center gap-x-6 md:h-16 md:flex-nowrap">
        <Link href="/" className="flex h-14 min-w-0 items-center gap-2.5 md:h-auto">
          <BrandMark />
          <span className="truncate font-display text-lg font-bold tracking-tight">
            {brandName}
          </span>
        </Link>

        <HeaderSearch className="hidden md:mx-auto md:block md:w-full md:max-w-xs lg:max-w-sm" />

        <nav
          aria-label="Основное меню"
          className="order-3 -mx-4 w-[calc(100%+2rem)] min-w-0 overflow-x-auto border-t border-graphite-800 px-4 md:order-none md:mx-0 md:ml-auto md:w-auto md:overflow-visible md:border-0 md:px-0"
        >
          <ul className="flex h-11 items-center gap-6 text-sm whitespace-nowrap">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="py-2 text-steel-200 underline-offset-[6px] transition-colors hover:text-paper hover:underline hover:decoration-accent hover:decoration-2"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* No prefetch: opening the cart re-prices it at the supplier. */}
        <Link
          href="/cart"
          prefetch={false}
          className="order-2 ml-auto inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-paper transition-colors hover:text-accent md:order-none md:ml-0"
          aria-label={cartCount > 0 ? `Корзина: ${cartCountLabel(cartCount)}` : 'Корзина пуста'}
          data-testid="header-cart"
        >
          <IconCart size={22} />
          Корзина
          {cartCount > 0 ? (
            <span
              className="inline-flex h-6 min-w-6 items-center justify-center rounded-sm bg-accent px-1.5 font-mono text-xs font-semibold text-ink"
              data-testid="header-cart-count"
            >
              {cartCount}
            </span>
          ) : null}
        </Link>
      </Container>
    </header>
  );
}
