'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cartCountLabel } from '@/lib/plural';
import { IconArrowRight } from './icons';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';

/** The cart itself, checkout and the order page have their own primary action at the bottom. */
function hiddenOn(pathname: string | null): boolean {
  if (pathname === null) return false;
  return (
    pathname === '/cart' ||
    pathname === '/checkout' ||
    pathname === '/o' ||
    pathname.startsWith('/o/')
  );
}

/**
 * Phones only (below md): a fixed bottom bar with the cart once it has lines. The spacer after
 * it keeps the end of the page (the footer) reachable above the bar.
 */
export function MobileCartBar({ cartCount }: { cartCount: number }) {
  const pathname = usePathname();
  if (cartCount <= 0 || hiddenOn(pathname)) return null;
  return (
    <>
      <div
        aria-hidden
        className="h-[calc(4rem+env(safe-area-inset-bottom))] bg-graphite-950 md:hidden"
      />
      <div
        className="mobile-cart-bar fixed inset-x-0 bottom-0 z-40 border-t border-graphite-700 bg-graphite-950 pb-[env(safe-area-inset-bottom)] text-paper md:hidden"
        data-testid="mobile-cart-bar"
      >
        <div className="flex h-16 items-center justify-between gap-3 px-4">
          <p className="min-w-0 text-sm">
            <span className="text-steel-400">В корзине </span>
            <span className="font-semibold">{cartCountLabel(cartCount)}</span>
          </p>
          {/* No prefetch: opening the cart re-prices it at the supplier. */}
          <Link
            href="/cart"
            prefetch={false}
            className={cn(buttonClass({ variant: 'primary', onDark: true }), 'shrink-0 px-4')}
          >
            Корзина
            <IconArrowRight size={18} />
          </Link>
        </div>
      </div>
    </>
  );
}
