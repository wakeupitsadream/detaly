import Link from 'next/link';
import type { ReactNode } from 'react';
import { hasSellerRequisites, REQUISITES_PENDING } from '@/lib/requisites';
import type { Brand } from '@/server/brand';
import { IconClock, IconExternal, IconPin, IconTelegram } from './icons';
import { PickupRouteLinks } from './PickupRouteLinks';
import { Container } from './ui/Container';

const SHOP_LINKS = [
  { href: '/vin', label: 'Подбор по VIN' },
  { href: '/returns', label: 'Возврат и обмен' },
  { href: '/about', label: 'О нас и реквизиты' },
];

const DOC_LINKS = [
  { href: '/docs/offer', label: 'Публичная оферта' },
  { href: '/docs/privacy', label: 'Политика обработки персональных данных' },
  { href: '/docs/consent', label: 'Согласие на обработку персональных данных' },
];

function telHrefOf(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

function LinkList({ label, links }: { label: string; links: { href: string; label: string }[] }) {
  return (
    <nav aria-label={label} className="min-w-0">
      <ul className="space-y-1">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="inline-flex min-h-10 items-center text-body text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A square 48 px messenger button, dark like the panel. */
function MessengerButton({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="grid size-12 place-items-center rounded-control bg-dark text-on-brand transition-colors hover:bg-dark-2"
    >
      {children}
    </a>
  );
}

/**
 * The footer (docs/design-v2.md, Footer): white with a hairline on top. The wordmark and the
 * links; the pickup point with the partner's logo, hours and routes; the phone in large type
 * with the messenger buttons; the seller requisites in small muted type on every page (law on
 * consumer protection, art. 9). Brand, point and requisites come only from env.
 */
export function Footer({ brand, year }: { brand: Brand; year: number }) {
  const { seller, pickup } = brand;
  const contacts = [seller.phone, seller.email].filter((part) => part !== null);
  const registration = [
    seller.inn ? `ИНН ${seller.inn}` : null,
    seller.ogrnip ? `ОГРНИП ${seller.ogrnip}` : null,
  ].filter((part) => part !== null);
  const phone = brand.contactPhone;
  const logo = brand.pickupLogo?.color ?? null;
  const telegram = brand.pickupLinks?.telegram ?? null;
  return (
    <footer className="site-footer border-t border-line bg-bg text-ink" data-testid="site-footer">
      <Container className="grid gap-10 py-10 md:grid-cols-2 md:py-14 lg:grid-cols-[1fr_1.15fr_1.1fr] lg:gap-12">
        <div className="min-w-0 space-y-5">
          <Link
            href="/"
            className="inline-block text-[1.625rem] leading-none font-extrabold tracking-[-0.02em] text-brand"
          >
            {brand.name}
          </Link>
          <LinkList label="Покупателям" links={SHOP_LINKS} />
          <LinkList label="Документы" links={DOC_LINKS} />
        </div>

        {pickup.address || pickup.name ? (
          <section aria-labelledby="footer-pickup" className="min-w-0 space-y-3">
            <div className="flex min-w-0 items-center gap-4">
              {logo ? (
                // A plain img: a small WebP from public/, no optimizer needed.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logo}
                  alt={pickup.name ?? ''}
                  width={80}
                  height={70}
                  loading="lazy"
                  decoding="async"
                  className="h-16 w-auto shrink-0"
                />
              ) : null}
              <div className="min-w-0">
                <p className="text-small text-muted">Точка выдачи и установки</p>
                <h2 id="footer-pickup" className="text-h3 wrap-anywhere">
                  {pickup.name ?? 'Пункт выдачи'}
                </h2>
              </div>
            </div>
            {pickup.address ? (
              <p className="flex min-w-0 items-start gap-2 text-body">
                <IconPin size={22} className="mt-0.5 shrink-0 text-brand" />
                <span className="min-w-0 wrap-anywhere">{pickup.address}</span>
              </p>
            ) : null}
            {pickup.hours ? (
              <p className="flex min-w-0 items-start gap-2 text-body">
                <IconClock size={22} className="mt-0.5 shrink-0 text-brand" />
                <span className="min-w-0">{pickup.hours}</span>
              </p>
            ) : null}
            <PickupRouteLinks brand={brand} className="pt-1" />
          </section>
        ) : null}

        <div className="min-w-0 space-y-5">
          {phone ? (
            <div>
              <a
                href={telHrefOf(phone)}
                className="text-[1.75rem] leading-tight font-extrabold tabular-nums wrap-anywhere hover:text-brand"
              >
                {phone}
              </a>
              <p className="mt-1 text-small text-muted">Звонок по Оренбургу</p>
            </div>
          ) : null}
          {telegram ? (
            <div className="flex gap-3">
              <MessengerButton href={telegram} label="Написать в Telegram">
                <IconTelegram size={24} />
              </MessengerButton>
            </div>
          ) : null}

          <div className="text-sm leading-relaxed text-muted">
            {hasSellerRequisites(seller) ? (
              <div className="space-y-0.5">
                <p className="wrap-anywhere">
                  {seller.name ? `ИП ${seller.name}` : 'Индивидуальный предприниматель'}
                </p>
                {registration.length > 0 ? (
                  <p className="tabular-nums wrap-anywhere" data-testid="footer-inn">
                    {registration.join(', ')}
                  </p>
                ) : null}
                {seller.address ? <p className="wrap-anywhere">{seller.address}</p> : null}
                {contacts.length > 0 ? (
                  <p className="wrap-anywhere">{contacts.join(' · ')}</p>
                ) : null}
              </div>
            ) : (
              // Nothing is set yet (a demo before the launch): one neutral line, no «уточняется».
              <p data-testid="footer-requisites-pending">{REQUISITES_PENDING}</p>
            )}
          </div>
        </div>
      </Container>

      <div className="border-t border-line">
        <Container className="flex flex-col gap-1 py-5 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {brand.name}
          </p>
          <p>
            Дизайн и разработка —{' '}
            <a
              href="https://maxim-batutin.ru"
              target="_blank"
              rel="noopener"
              className="inline-flex min-h-11 items-center gap-1 text-ink underline-offset-4 hover:underline sm:min-h-0"
            >
              maxim-batutin.ru
              <IconExternal size={14} />
            </a>
          </p>
        </Container>
      </div>
    </footer>
  );
}
