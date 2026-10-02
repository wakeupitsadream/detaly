/**
 * A plain GET form to /search (not next/form): no client-side prefetch, so typing and
 * hovering never spend the visitor's search limit.
 */
export function SearchBar({
  defaultValue = '',
  localOnly = false,
  autoFocus = false,
  large = false,
}: {
  defaultValue?: string;
  localOnly?: boolean;
  autoFocus?: boolean;
  large?: boolean;
}) {
  return (
    <form method="get" action="/search" role="search" className="w-full min-w-0">
      <label htmlFor="search-q" className="mb-2 block text-sm font-medium text-muted">
        Артикул детали
      </label>
      <div className="flex w-full min-w-0 gap-2">
        <input
          id="search-q"
          name="q"
          type="search"
          inputMode="search"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          maxLength={64}
          defaultValue={defaultValue}
          autoFocus={autoFocus}
          placeholder="Например, OC90 или W 914/2"
          className={`min-w-0 flex-1 rounded-xl border border-line bg-card px-4 text-ink shadow-sm outline-none placeholder:text-faint focus:border-accent ${
            large ? 'h-14 text-lg' : 'h-12 text-base'
          }`}
        />
        {localOnly ? <input type="hidden" name="local" value="1" /> : null}
        <button
          type="submit"
          className={`shrink-0 rounded-xl bg-accent px-5 font-semibold text-white shadow-sm transition-colors hover:bg-accent-strong ${
            large ? 'h-14 text-lg' : 'h-12 text-base'
          }`}
        >
          Найти
        </button>
      </div>
      <p className="mt-2 text-sm text-muted">
        Ищем по артикулу и бренду: поиска по названию нет, зато цена и дата получения сразу точные.
      </p>
    </form>
  );
}
