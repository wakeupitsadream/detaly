import Link from 'next/link';
import { cartCountLabel } from '@/lib/plural';
import { HeaderNavChips, HeaderNavLinks, HeaderTail } from './HeaderNav';
import { HeaderSearch, HomeSearchHint } from './HeaderSearch';
import { IconCart, IconChevron, IconClock, IconPhone, IconPin } from './icons';
import { Container } from './ui/Container';
import { cn } from './ui/cn';

export { cartCountLabel };

/** The site sections: the desktop link row and the phone chip row («Основное меню»). */
const NAV = [
  { href: '/vin', label: 'Подбор по VIN' },
  { href: '/returns', label: 'Возврат' },
  { href: '/about', label: 'О нас' },
];

/** Desktop only: the documents live in the footer on phones. */
const DESKTOP_NAV = [...NAV, { href: '/docs/offer', label: 'Документы' }];

/** The city of the only pickup point (stock badges say «В Оренбурге» too). */
const CITY = 'Оренбург';

export interface SiteHeaderProps {
  brandName: string;
  cartCount: number;
  /** Phone for questions (Brand.contactPhone): a call button on phones, the number on desktop. */
  phone?: string | null;
  /** «tel:» href of the phone (server/brand.ts telHref). */
  phoneHref?: string | null;
  /** PICKUP_HOURS as written. */
  hours?: string | null;
  /** PICKUP_POINT_NAME. */
  pickupName?: string | null;
  /** PICKUP_EMBLEM_WHITE_SRC: the partner's white emblem; a pin without it. */
  emblemSrc?: string | null;
}

function Wordmark({ name, className }: { name: string; className?: string }) {
  return (
    <Link
      href="/"
      className={cn(
        'min-h-11 min-w-0 items-center truncate text-[1.375rem] leading-none font-extrabold tracking-[-0.02em] text-on-brand lg:text-[1.625rem]',
        className,
      )}
    >
      {name}
    </Link>
  );
}

function CartCount({ count }: { count: number }) {
  return (
    <span
      className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-on-brand px-1.5 text-sm leading-none font-bold text-brand tabular-nums"
      data-testid="header-cart-count"
    >
      {count}
    </span>
  );
}

function cartLabel(count: number): string {
  return count > 0 ? `Корзина: ${cartCountLabel(count)}` : 'Корзина пуста';
}

/** «[emblem] Оренбург · Сервис · Как добраться ›»: where the parts are picked up. */
function PickupLine({
  pickupName,
  emblemSrc,
  className,
}: Pick<SiteHeaderProps, 'pickupName' | 'emblemSrc'> & { className?: string }) {
  return (
    <div className={cn('flex min-h-11 min-w-0 items-center gap-2 text-small', className)}>
      {emblemSrc ? (
        // A plain img: a small WebP from public/, no optimizer needed.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={emblemSrc}
          alt=""
          width={40}
          height={24}
          className="h-6 w-auto shrink-0 md:h-7"
          decoding="async"
        />
      ) : (
        <IconPin size={20} className="shrink-0" />
      )}
      <span className="min-w-0 truncate max-sm:text-sm">
        {CITY}
        {pickupName ? (
          <>
            {' · '}
            <span className="font-semibold">{pickupName}</span>
          </>
        ) : null}
      </span>
      <Link
        href="/about#pickup"
        className="ml-auto inline-flex min-h-11 shrink-0 items-center text-sm font-semibold whitespace-nowrap underline-offset-4 hover:underline md:ml-4 md:text-[0.9375rem]"
      >
        Как добраться
        <IconChevron size={16} />
      </Link>
    </div>
  );
}

/**
 * The brand plate (docs/design-v2.md, SiteHeader): `bg-brand`, white text, a rounded bottom.
 * Three stacked parts, siblings in the page column so the middle one can stick:
 *  - top: phones — the wordmark, call and cart buttons, the pickup line; desktop — the small
 *    section links with the phone and hours;
 *  - search (sticky): the search pill; desktop adds the wordmark and the cart. It has its own
 *    rounded bottom, hidden while the bottom part sits under it in the same red, so once the
 *    page scrolls only this compact plate with the search stays;
 *  - bottom (slides under the sticky part): phones — the home hint and the section chips
 *    («Основное меню»: e2e opens «О нас» from it on 375 px), on the home page only (HeaderTail);
 *    desktop — the pickup line. The current section is marked with aria-current="page".
 */
export function SiteHeader({
  brandName,
  cartCount,
  phone = null,
  phoneHref = null,
  hours = null,
  pickupName = null,
  emblemSrc = null,
}: SiteHeaderProps) {
  const callHref = phone ? (phoneHref ?? `tel:${phone.replace(/[^\d+]/g, '')}`) : null;
  return (
    <>
      <header className="site-header bg-brand text-on-brand">
        {/* Phones. */}
        <Container className="md:hidden">
          <div className="flex h-14 min-w-0 items-center gap-1">
            <Wordmark name={brandName} className="mr-auto inline-flex" />
            {callHref ? (
              <a
                href={callHref}
                aria-label={`Позвонить: ${phone}`}
                className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-on-brand/10"
              >
                <IconPhone size={24} />
              </a>
            ) : null}
            {/* No prefetch: opening the cart re-prices it at the supplier. */}
            <Link
              href="/cart"
              prefetch={false}
              aria-label={cartLabel(cartCount)}
              data-testid="header-cart"
              className="relative grid size-11 shrink-0 place-items-center rounded-full hover:bg-on-brand/10"
            >
              <IconCart size={26} />
              {cartCount > 0 ? (
                <span className="absolute -top-0.5 -right-1">
                  <CartCount count={cartCount} />
                </span>
              ) : null}
            </Link>
          </div>
          <PickupLine pickupName={pickupName} emblemSrc={emblemSrc} />
        </Container>

        {/* Desktop. */}
        <Container className="hidden h-12 items-center gap-6 md:flex">
          <nav aria-label="Основное меню" className="min-w-0">
            <HeaderNavLinks items={DESKTOP_NAV} />
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-5 text-small whitespace-nowrap">
            {hours ? (
              <span className="hidden min-w-0 items-center gap-1.5 truncate lg:inline-flex">
                <IconClock size={18} className="shrink-0" />
                {hours}
              </span>
            ) : null}
            {callHref ? (
              <a
                href={callHref}
                className="inline-flex min-h-11 items-center gap-1.5 font-bold tabular-nums underline-offset-4 hover:underline"
              >
                <IconPhone size={18} />
                {phone}
              </a>
            ) : null}
          </div>
        </Container>
      </header>

      <div
        className="site-header sticky top-0 z-30 rounded-b-header bg-brand text-on-brand lg:rounded-b-header-lg"
        data-testid="header-search-bar"
      >
        <Container className="flex items-center gap-6 pt-2 pb-3 md:py-3">
          <Wordmark name={brandName} className="hidden shrink-0 md:inline-flex" />
          <HeaderSearch className="flex-1" />
          <Link
            href="/cart"
            prefetch={false}
            aria-label={cartLabel(cartCount)}
            data-testid="header-cart"
            className="hidden min-h-12 shrink-0 items-center gap-2 rounded-full px-3 text-base font-semibold hover:bg-on-brand/10 md:inline-flex"
          >
            <IconCart size={26} />
            Корзина
            {cartCount > 0 ? <CartCount count={cartCount} /> : null}
          </Link>
        </Container>
      </div>

      <HeaderTail className="site-header relative z-20 -mt-8 rounded-b-header bg-brand pt-10 text-on-brand lg:-mt-10 lg:rounded-b-header-lg lg:pt-12">
        <Container className="pb-4 md:hidden">
          <HomeSearchHint className="mb-3" />
          {/* py-1.5: room for the focus ring inside the scrolling row (it clips both axes). */}
          <nav
            aria-label="Основное меню"
            className="-mx-4 -my-1.5 min-w-0 overflow-x-auto px-4 py-1.5"
          >
            <HeaderNavChips items={NAV} />
          </nav>
        </Container>
        <Container className="hidden items-center gap-6 pb-3 md:flex lg:pb-4">
          <PickupLine pickupName={pickupName} emblemSrc={emblemSrc} className="min-w-0" />
          <HomeSearchHint className="ml-auto shrink-0" />
        </Container>
      </HeaderTail>
    </>
  );
}
