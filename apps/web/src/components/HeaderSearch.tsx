'use client';

import { normalizeVin } from '@detaly/vin/vin';
import { usePathname, useSearchParams } from 'next/navigation';
import type { FormEvent } from 'react';
import { DEMO_EXAMPLES } from '@/lib/demo-articles';
import { vinRequestHref } from '@/lib/vin-link';
import { IconSearch } from './icons';
import { cn } from './ui/cn';

/** Where a header query goes: a VIN to the request form, anything else to the article search. */
export function headerSearchTarget(query: string): string {
  const vin = normalizeVin(query);
  if (vin) return vinRequestHref({ vin });
  return `/search?${new URLSearchParams({ q: query.trim() }).toString()}`;
}

/**
 * The search pill of the brand header on every page (docs/design-v2.md, HeaderSearch): white,
 * 56 px, a magnifier on the left, «Найти» inside on the right from md. A plain GET form to
 * /search, so it works without JS (the search page itself sends a VIN on to /vin) and typing
 * never prefetches (a search spends the visitor's limit). With JS a valid VIN goes straight to
 * /vin?vin=… The accessible names «Артикул детали …» and «Найти» are what e2e relies on.
 */
export function HeaderSearch({ className }: { className?: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // On the results page the pill shows the query it answers.
  const current = pathname === '/search' ? (searchParams?.get('q') ?? '') : '';
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const query = new FormData(event.currentTarget).get('q');
    if (typeof query !== 'string') return;
    const target = headerSearchTarget(query);
    if (!target.startsWith('/vin')) return;
    event.preventDefault();
    // A full navigation, like the plain form: no router context needed (unit tests render it).
    window.location.assign(target);
  };
  return (
    <form
      method="get"
      action="/search"
      role="search"
      aria-label="Поиск запчастей"
      onSubmit={onSubmit}
      className={cn(
        'relative flex h-14 w-full min-w-0 items-center rounded-full bg-bg text-ink',
        'focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-on-brand',
        className,
      )}
    >
      {/* Phones: the magnifier is the submit button; from md it is a picture and «Найти» is
          a text button on the right. */}
      <button
        type="submit"
        aria-label="Найти"
        className="grid h-14 w-13 shrink-0 place-items-center rounded-l-full text-ink md:hidden"
      >
        <IconSearch size={24} />
      </button>
      <IconSearch size={24} className="ml-5 hidden shrink-0 text-ink md:block" />
      <input
        id="header-q"
        name="q"
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        required
        maxLength={64}
        key={current}
        defaultValue={current}
        placeholder="Артикул или VIN"
        aria-label="Артикул детали или VIN"
        className={cn(
          'h-full min-w-0 flex-1 rounded-full bg-transparent pr-5 text-[1.0625rem] text-ink',
          'placeholder:text-muted focus-visible:outline-none md:pl-3',
          '[&::-webkit-search-cancel-button]:hidden',
        )}
      />
      <button
        type="submit"
        className="mr-1.5 hidden h-11 shrink-0 items-center rounded-full bg-brand px-6 text-base font-semibold text-on-brand transition-colors hover:bg-brand-hover md:inline-flex"
      >
        Найти
      </button>
    </form>
  );
}

/**
 * Home page only: one example under the search, «Например, OC 90 — масляный фильтр», linking
 * an article that answers (also in the demo fixtures).
 */
export function HomeSearchHint({ className }: { className?: string }) {
  const pathname = usePathname();
  const example = DEMO_EXAMPLES[0];
  if (pathname !== '/' || !example) return null;
  return (
    <p className={cn('text-sm text-on-brand/90', className)}>
      Например,{' '}
      <a
        href={`/search?q=${example.q}`}
        // Padding grows the target to 44 px without moving the line (an inline box).
        className="-mx-1 px-1 py-3.5 font-semibold text-on-brand underline decoration-on-brand/50 underline-offset-4 hover:decoration-on-brand"
      >
        {example.article}
      </a>{' '}
      — {example.what.toLowerCase()}
    </p>
  );
}
