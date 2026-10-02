import Link from 'next/link';
import type { Brand } from '@/server/brand';

const LINKS = [
  { href: '/docs/offer', label: 'Публичная оферта' },
  { href: '/docs/privacy', label: 'Политика обработки персональных данных' },
  { href: '/docs/consent', label: 'Согласие на обработку персональных данных' },
  { href: '/returns', label: 'Возврат и обмен' },
  { href: '/about', label: 'О сервисе и реквизиты' },
];

/** Seller requisites on every page (law on consumer protection, art. 9). */
export function Footer({ brand, year }: { brand: Brand; year: number }) {
  const { seller } = brand;
  return (
    <footer className="mt-16 border-t border-line bg-card" data-testid="site-footer">
      <div className="mx-auto grid max-w-5xl min-w-0 grid-cols-1 gap-8 px-4 py-8 text-sm md:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <div className="text-base font-semibold">{brand.name}</div>
          <p className="wrap-anywhere">
            {seller.name ? `ИП ${seller.name}` : 'Индивидуальный предприниматель'}
          </p>
          <p className="wrap-anywhere" data-testid="footer-inn">
            ИНН {seller.inn ?? 'уточняется'}
            {seller.ogrnip ? `, ОГРНИП ${seller.ogrnip}` : ''}
          </p>
          {seller.address ? <p className="wrap-anywhere">{seller.address}</p> : null}
          {seller.phone || seller.email ? (
            <p className="wrap-anywhere">
              {[seller.phone, seller.email].filter((part) => part !== null).join(' · ')}
            </p>
          ) : null}
          <p className="pt-2 text-muted">
            © {year} {brand.name}
          </p>
        </div>
        <nav aria-label="Документы" className="min-w-0">
          <ul className="space-y-1.5">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="text-muted underline-offset-2 hover:underline">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
