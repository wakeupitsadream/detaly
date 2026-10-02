import Link from 'next/link';
import { hasSellerRequisites, REQUISITES_PENDING } from '@/lib/requisites';
import type { Brand } from '@/server/brand';
import { IconExternal } from './icons';
import { BrandMark } from './ui/BrandMark';
import { Container } from './ui/Container';

const LINKS = [
  { href: '/docs/offer', label: 'Публичная оферта' },
  { href: '/docs/privacy', label: 'Политика обработки персональных данных' },
  { href: '/docs/consent', label: 'Согласие на обработку персональных данных' },
  { href: '/returns', label: 'Возврат и обмен' },
  { href: '/about', label: 'О сервисе и реквизиты' },
];

/** A rivet in a corner of the requisites plate. */
function Rivet({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={`absolute size-1.5 rounded-full bg-graphite-700 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)] ${className}`}
    />
  );
}

/**
 * Seller requisites on every page (law on consumer protection, art. 9), set as a data plate
 * with rivets. Brand and requisites come only from env.
 */
export function Footer({ brand, year }: { brand: Brand; year: number }) {
  const { seller } = brand;
  const contacts = [seller.phone, seller.email].filter((part) => part !== null);
  const registration = [
    seller.inn ? `ИНН ${seller.inn}` : null,
    seller.ogrnip ? `ОГРНИП ${seller.ogrnip}` : null,
  ].filter((part) => part !== null);
  return (
    <footer
      className="site-footer grain-dark bg-graphite-950 bg-blueprint text-steel-200"
      data-testid="site-footer"
    >
      <Container className="grid gap-10 py-12 md:grid-cols-2 md:py-16 lg:grid-cols-[1fr_1.35fr_1fr] lg:gap-12">
        <div className="min-w-0 space-y-4">
          <div className="flex min-w-0 items-center gap-2.5 text-paper">
            <BrandMark size={32} />
            <span className="truncate font-display text-xl font-bold tracking-tight">
              {brand.name}
            </span>
          </div>
          <p className="max-w-xs text-sm text-steel-400">
            Запчасти от людей, которые их же и поставят.
          </p>
        </div>

        <div className="relative min-w-0 self-start rounded border border-graphite-700 bg-graphite-900/70 px-5 py-4 md:row-span-2 lg:row-span-1">
          <Rivet className="top-2 left-2" />
          <Rivet className="top-2 right-2" />
          <Rivet className="bottom-2 left-2" />
          <Rivet className="right-2 bottom-2" />
          <p className="text-label text-steel-400">Продавец</p>
          {hasSellerRequisites(seller) ? (
            <div className="mt-2 space-y-1 font-mono text-[0.8125rem] leading-relaxed text-steel-200">
              <p className="wrap-anywhere text-paper">
                {seller.name ? `ИП ${seller.name}` : 'Индивидуальный предприниматель'}
              </p>
              {registration.length > 0 ? (
                <p className="wrap-anywhere" data-testid="footer-inn">
                  {registration.join(', ')}
                </p>
              ) : null}
              {seller.address ? <p className="wrap-anywhere">{seller.address}</p> : null}
              {contacts.length > 0 ? <p className="wrap-anywhere">{contacts.join(' · ')}</p> : null}
            </div>
          ) : (
            // Nothing is set yet (a demo before the launch): one neutral line, no «уточняется».
            <p className="mt-2 text-sm text-steel-200" data-testid="footer-requisites-pending">
              {REQUISITES_PENDING}
            </p>
          )}
        </div>

        <nav aria-label="Документы" className="min-w-0">
          <p className="text-label text-steel-400">Документы</p>
          <ul className="mt-3 space-y-2 text-sm">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="text-steel-200 underline-offset-4 transition-colors hover:text-paper hover:underline"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Container>

      <div className="border-t border-graphite-800">
        <Container className="flex flex-col gap-2 py-5 text-xs text-steel-400 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {brand.name}
          </p>
          <p>
            Дизайн и разработка —{' '}
            <a
              href="https://maxim-batutin.ru"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1 text-steel-200 underline-offset-4 hover:text-paper hover:underline"
            >
              maxim-batutin.ru
              <IconExternal size={12} />
            </a>
          </p>
        </Container>
      </div>
    </footer>
  );
}
