import type { Brand } from '@/server/brand';

const MISSING = 'уточняется';

/** Seller requisites as a definition list (footer, /about). */
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
      className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 ${compact ? 'gap-y-0.5 text-sm' : 'gap-y-1.5'}`}
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 wrap-anywhere" data-testid={`requisite-${label}`}>
            {value ?? <span className="text-faint">{MISSING}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
