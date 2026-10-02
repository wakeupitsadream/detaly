import { hasSellerRequisites, REQUISITES_PARTIAL, REQUISITES_PENDING } from '@/lib/requisites';
import type { Brand } from '@/server/brand';
import { cn } from './ui/cn';

/**
 * Seller requisites as a definition list (/about): labels as mono captions, values set like a
 * data plate. `compact` for narrow places. Only the rows that are set are listed; while none
 * is set (a demo before the launch) one neutral line stands instead of the list.
 */
export function Requisites({ brand, compact = false }: { brand: Brand; compact?: boolean }) {
  const { seller } = brand;
  if (!hasSellerRequisites(seller)) {
    return (
      <div className={cn('space-y-1', compact ? 'text-sm' : 'text-[0.9375rem]')}>
        <p className="font-medium" data-testid="requisites-pending">
          {REQUISITES_PENDING}.
        </p>
        <p className="text-sm text-muted">
          Они будут опубликованы здесь и в документах до того, как откроется оформление заказов.
        </p>
      </div>
    );
  }
  const all: [string, string | null][] = [
    ['Продавец', seller.name ? `ИП ${seller.name}` : null],
    ['ИНН', seller.inn],
    ['ОГРНИП', seller.ogrnip],
    ['Адрес', seller.address],
    ['Телефон', seller.phone],
    ['E-mail', seller.email],
  ];
  const rows = all.filter((row): row is [string, string] => row[1] !== null);
  const partial = rows.length < all.length;
  return (
    <>
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
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {partial ? <p className="mt-3 text-sm text-muted">{REQUISITES_PARTIAL}.</p> : null}
    </>
  );
}
