import type { Brand } from '@/server/brand';
import { cn } from './ui/cn';

const MISSING = 'уточняется';

/**
 * Seller requisites as a definition list (/about): labels as mono captions, values set like a
 * data plate. `compact` for narrow places.
 */
export function Requisites({ brand, compact = false }: { brand: Brand; compact?: boolean }) {
  const { seller } = brand;
  const rows: [string, string | null][] = [
    ['Продавец', seller.name ? `ИП ${seller.name}` : null],
    ['ИНН', seller.inn],
    ['ОГРНИП', seller.ogrnip],
    ['Адрес', seller.address],
    ['Телефон', seller.phone],
    ['E-mail', seller.email],
  ];
  return (
    <dl
      className={cn(
        'grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4',
        compact ? 'text-sm' : 'text-[0.9375rem]',
      )}
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt
            className={cn(
              'border-b border-dashed border-line text-label text-muted',
              compact ? 'py-1' : 'py-2',
            )}
          >
            {label}
          </dt>
          <dd
            className={cn(
              'min-w-0 border-b border-dashed border-line font-mono wrap-anywhere',
              compact ? 'py-0.5' : 'py-1.5',
            )}
            data-testid={`requisite-${label}`}
          >
            {value ?? <span className="font-sans text-faint">{MISSING}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
