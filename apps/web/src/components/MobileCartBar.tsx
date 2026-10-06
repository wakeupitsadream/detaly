'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cartCountLabel } from '@/lib/plural';
import { IconArrowRight, IconCart } from './icons';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';

/** The cart itself, checkout and the order page have their own primary action at the bottom. */
function hiddenOn(pathname: string | null): boolean {
  if (pathname === null) return false;
  return (
    pathname === '/cart' ||
    pathname === '/checkout' ||
    pathname === '/o' ||
    pathname.startsWith('/o/') ||
    // A proposal page /p/<token> has its own bottom bar in the same place.
    pathname.startsWith('/p/')
  );
}

/**
 * Phones only (below md): a white floating panel at the bottom once the cart has lines, with
 * the number of lines and the way to checkout (through the cart, which re-prices first). The
 * spacer after the page keeps the end of the footer reachable above the panel.
 */
export function MobileCartBar({ cartCount }: { cartCount: number }) {
  const pathname = usePathname();
  if (cartCount <= 0 || hiddenOn(pathname)) return null;
  return (
    <>
      <div aria-hidden className="h-[calc(5.5rem+env(safe-area-inset-bottom))] md:hidden" />
      <div
        className="mobile-cart-bar fixed inset-x-0 bottom-0 z-40 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:hidden"
        data-testid="mobile-cart-bar"
      >
        <div className="flex h-17 items-center justify-between gap-3 rounded-tile border border-line bg-bg pr-2.5 pl-4 text-ink shadow-float">
          <p className="flex min-w-0 items-center gap-2.5 text-small">
            <IconCart size={24} className="shrink-0 text-brand" />
            <span className="min-w-0">
              <span className="text-muted">В корзине </span>
              <span className="font-bold whitespace-nowrap">{cartCountLabel(cartCount)}</span>
            </span>
          </p>
          {/* No prefetch: opening the cart re-prices it at the supplier. */}
          <Link
            href="/cart"
            prefetch={false}
            className={cn(buttonClass({ variant: 'primary' }), 'shrink-0 px-5')}
          >
            Оформить
            <IconArrowRight size={20} />
          </Link>
        </div>
      </div>
    </>
  );
}
