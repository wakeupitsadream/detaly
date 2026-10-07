'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cartCountLabel } from '@/lib/plural';
import { IconArrowRight, IconCart } from './icons';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';

/**
 * The cart itself, checkout, the order page, a proposal and the VIN form have their own primary
 * action at the bottom.
 */
function hiddenOn(pathname: string | null): boolean {
  if (pathname === null) return false;
  return (
    pathname === '/cart' ||
    pathname === '/checkout' ||
    pathname === '/o' ||
    pathname.startsWith('/o/') ||
    // A proposal page /p/<token> has its own bottom bar in the same place.
    pathname.startsWith('/p/') ||
    // The VIN request form: «Оформить» under the thumb would compete with «Отправить заявку»
    // and a stray tap would leave the form (no draft is kept).
    pathname === '/vin' ||
    pathname.startsWith('/vin/')
  );
}

/**
 * On /search the bar waits until the first «В корзину» has scrolled out of view: at 375×812 it
 * would cover the first offer's price and button, the very thing a returning buyer came for.
 * True while the bar should stay away; elsewhere (and with no offers on the page) false.
 */
function useFirstOfferInView(active: boolean): boolean {
  const [inView, setInView] = useState(active);
  useEffect(() => {
    if (!active) {
      setInView(false);
      return;
    }
    const target = document.querySelector('[data-testid="add-to-cart"]');
    if (!target || typeof IntersectionObserver === 'undefined') {
      setInView(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      // Gone above the screen or still below it: only «on screen» keeps the bar away.
      setInView(entry?.isIntersecting ?? false);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);
  return inView;
}

/**
 * Phones only (below md): a white floating panel at the bottom once the cart has lines, with
 * the number of lines and the way to checkout (through the cart, which re-prices first). The
 * footer makes room for it (`.mobile-cart-bar` in globals.css).
 */
export function MobileCartBar({ cartCount }: { cartCount: number }) {
  const pathname = usePathname();
  const offerInView = useFirstOfferInView(pathname === '/search' && cartCount > 0);
  if (cartCount <= 0 || hiddenOn(pathname) || offerInView) return null;
  return (
    <div
      className="mobile-cart-bar fixed inset-x-0 bottom-0 z-40 px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:hidden"
      data-testid="mobile-cart-bar"
    >
      <div className="flex h-15 items-center justify-between gap-3 rounded-tile border border-line bg-bg pr-1.5 pl-4 text-ink shadow-float">
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
  );
}
