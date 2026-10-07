'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

/**
 * Height of what covers the viewport on a phone while the bar may show: the sticky search plate
 * at the top (pt-2 + 56 px pill + pb-3 = 76 px, with a few px to spare) and the floating bar
 * itself at the bottom (60 px card + 8 px gap + 8 px to spare).
 */
const COVERED_TOP_PX = 84;
const COVERED_BOTTOM_PX = 76;

/**
 * A floating bottom bar that steps aside while the same action is on screen (the «Оформить»
 * of the cart total, the take button of a proposal): two identical primary buttons one over
 * the other read as two different steps. It watches the button itself, not its card, and only
 * steps aside while the whole button is visible and not under the sticky search plate, so a
 * phone screen never shows neither. The bar stays mounted (the footer keeps its room,
 * `.mobile-cart-bar` in globals.css) and is only made invisible, which also takes it out of the
 * tab order. Without JS or IntersectionObserver it just stays.
 */
export function HideWhileInView({
  target,
  className,
  testId,
  children,
}: {
  /**
   * CSS selectors of the on-page button the bar repeats, tried in order (the first that is on
   * the page is watched): «Оформить заказ», else «Позвонить», …
   */
  target: string | readonly string[];
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const [inView, setInView] = useState(false);
  const selectors = typeof target === 'string' ? target : target.join('\n');
  useEffect(() => {
    let element: Element | null = null;
    for (const selector of selectors.split('\n')) {
      element = document.querySelector(selector);
      if (element) break;
    }
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setInView(Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.99));
      },
      {
        rootMargin: `-${COVERED_TOP_PX}px 0px -${COVERED_BOTTOM_PX}px 0px`,
        threshold: [0, 0.99, 1],
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [selectors]);
  return (
    <div
      className={cn(className, inView && 'invisible')}
      data-testid={testId}
      data-in-view={inView ? '' : undefined}
      aria-hidden={inView || undefined}
    >
      {children}
    </div>
  );
}
