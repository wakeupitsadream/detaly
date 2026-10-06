'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { IconChevron } from './icons';
import { cn } from './ui/cn';

export interface NavItem {
  href: string;
  label: string;
}

/** The section the page belongs to: /docs/privacy is under «Документы» (/docs/offer). */
function isCurrent(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  const section = href.split('/').slice(0, 2).join('/');
  return pathname === href || pathname.startsWith(`${section}/`) || pathname === section;
}

/** Desktop: the small section links of the top row, the current one bold and underlined. */
export function HeaderNavLinks({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  return (
    <ul className="flex items-center gap-6 text-small whitespace-nowrap">
      {items.map((item) => {
        const current = isCurrent(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'inline-flex min-h-11 items-center underline-offset-4 hover:underline',
                current && 'font-bold underline decoration-2',
              )}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Phones: the section chips under the search; the current one white with brand text. */
export function HeaderNavChips({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();
  return (
    <ul className="flex items-center gap-2 whitespace-nowrap">
      {items.map((item, index) => {
        const current = isCurrent(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'inline-flex h-11 items-center gap-0.5 rounded-full px-4 text-[0.9375rem] font-semibold',
                current ? 'bg-on-brand text-brand' : 'bg-on-brand/15 hover:bg-on-brand/25',
              )}
            >
              {item.label}
              {index === 0 ? <IconChevron size={18} /> : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The part of the brand plate that slides under the sticky search. On phones it carries the
 * home hint and the section chips, which only the home page needs: elsewhere it is left out on
 * phones, so the first offer of a search comes up a whole row higher (the footer and the empty
 * search keep the links). From md it carries the pickup line on every page.
 */
export function HeaderTail({ className, children }: { className?: string; children: ReactNode }) {
  const pathname = usePathname();
  return <div className={cn(className, pathname !== '/' && 'max-md:hidden')}>{children}</div>;
}
