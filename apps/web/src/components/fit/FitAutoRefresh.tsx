'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** How often the cart re-renders while the master checks a line (step 4). */
export const FIT_REFRESH_MS = 30_000;

/**
 * While a fit check of the cart waits for the master, the page re-renders itself every 30 s
 * (router.refresh: the server components only, what was typed stays). Only with JavaScript;
 * without it the line has an «Обновить» link. Renders nothing.
 */
export function FitAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      // Not while a sheet is open: the form keeps what is typed in it anyway, but a re-render
      // under an open dialog would only move things the visitor is looking at.
      if (document.querySelector('dialog[open]') === null) router.refresh();
    }, FIT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
