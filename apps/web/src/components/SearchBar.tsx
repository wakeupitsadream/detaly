import { IconSearch } from './icons';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';
import { inputClass } from './ui/Input';

/**
 * A plain GET form to /search (not next/form): no client-side prefetch, so typing and
 * hovering never spend the visitor's search limit. The label «Артикул детали», the button
 * «Найти» and id="search-q" are what e2e and the header search rely on.
 */
export function SearchBar({
  defaultValue = '',
  localOnly = false,
  autoFocus = false,
  large = false,
  onDark = false,
  hint = true,
}: {
  defaultValue?: string;
  localOnly?: boolean;
  autoFocus?: boolean;
  large?: boolean;
  /** On a graphite section (the hero): light label and hint. */
  onDark?: boolean;
  hint?: boolean;
}) {
  return (
    <form method="get" action="/search" role="search" className="w-full min-w-0">
      <label
        htmlFor="search-q"
        className={cn('mb-2 block text-label', onDark ? 'text-steel-400' : 'text-muted')}
      >
        Артикул детали
      </label>
      <div className="flex w-full min-w-0 gap-2">
        <div className="relative min-w-0 flex-1">
          <IconSearch
            size={large ? 22 : 20}
            className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted"
          />
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
            placeholder="Например, OC90"
            aria-describedby={hint ? 'search-q-hint' : undefined}
            className={inputClass({
              size: large ? 'lg' : 'md',
              mono: true,
              className: cn(large ? 'pl-12' : 'pl-11', onDark && 'border-graphite-700'),
            })}
          />
        </div>
        {localOnly ? <input type="hidden" name="local" value="1" /> : null}
        <button
          type="submit"
          className={cn(
            buttonClass({ variant: 'primary', size: large ? 'lg' : 'md', onDark }),
            'shrink-0',
            // Narrow on phones so the placeholder «Например, OC90» fits next to the button.
            // `!`: buttonClass lg already sets px-7, and cn() does not merge conflicting classes.
            large ? 'h-14 px-4! sm:px-6! md:px-8!' : 'h-12',
          )}
        >
          Найти
        </button>
      </div>
      {hint ? (
        <p
          id="search-q-hint"
          className={cn('mt-2 text-sm', onDark ? 'text-steel-400' : 'text-muted')}
        >
          Ищем по артикулу и бренду: поиска по названию нет, зато цена и дата получения сразу
          точные.
        </p>
      ) : null}
    </form>
  );
}
