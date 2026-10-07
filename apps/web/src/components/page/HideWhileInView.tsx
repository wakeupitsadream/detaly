'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

/**
 * A floating bottom bar that steps aside while the same action is on screen (the «Оформить»
 * of the cart total, the take button of a proposal): two identical primary buttons one over
 * the other read as two different steps. The bar stays mounted (the footer keeps its room,
 * `.mobile-cart-bar` in globals.css) and is only made invisible, which also takes it out of
 * the tab order. Without JS or IntersectionObserver it just stays.
 */
export function HideWhileInView({
  target,
  className,
  testId,
  children,
}: {
  /** CSS selector of the on-page button the bar repeats. */
  target: string;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = document.querySelector(target);
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      setInView(entry?.isIntersecting ?? false);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [target]);
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
