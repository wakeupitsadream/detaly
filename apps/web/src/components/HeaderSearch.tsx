'use client';

import { usePathname } from 'next/navigation';
import { IconSearch } from './icons';
import { cn } from './ui/cn';

/** Pages with their own big search form: the header one would only duplicate it. */
const HIDDEN_ON = new Set(['/', '/search']);

/**
 * Compact article search in the header of inner pages (md+). A plain GET form like SearchBar;
 * its own id and accessible names, so «Артикул детали» and «Найти» stay unique on a page.
 */
export function HeaderSearch({ className }: { className?: string }) {
  const pathname = usePathname();
  if (pathname !== null && HIDDEN_ON.has(pathname)) return null;
  return (
    <form
      method="get"
      action="/search"
      role="search"
      aria-label="Быстрый поиск"
      className={cn('relative min-w-0', className)}
    >
      <input
        id="header-q"
        name="q"
        type="search"
        inputMode="search"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        required
        maxLength={64}
        placeholder="Артикул, например OC90"
        aria-label="Поиск по артикулу из шапки"
        className={cn(
          'h-10 w-full min-w-0 rounded border border-graphite-700 bg-graphite-800 pr-11 pl-3.5',
          'font-mono text-sm text-paper placeholder:text-steel-400',
          'transition-colors hover:border-steel-400 focus:border-accent focus-visible:outline-none',
        )}
      />
      <button
        type="submit"
        aria-label="Искать"
        className="absolute top-0 right-0 grid size-10 place-items-center text-steel-200 hover:text-accent"
      >
        <IconSearch size={18} />
      </button>
    </form>
  );
}
