'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonClass } from '@/components/ui/Button';

/**
 * «Найти по артикулу» of the empty cart: with JavaScript it puts the cursor into the header
 * search (#header-q) right here; without it, or when the field is not on the page, it is a plain
 * link to the home page with the same search.
 */
export function FindByArticleLink({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Link
      href="/"
      className={buttonClass({ size: 'lg', block: true })}
      onClick={(event) => {
        const field = document.getElementById('header-q');
        if (!(field instanceof HTMLInputElement)) return;
        event.preventDefault();
        field.scrollIntoView({ block: 'center' });
        field.focus();
      }}
    >
      {icon}
      {children}
    </Link>
  );
}
