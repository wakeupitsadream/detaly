import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  type IconComponent,
  IconCalendar,
  IconReceipt,
  IconReturn,
  IconSts,
  IconWallet,
  IconWrench,
} from '@/components/icons';
import { cn } from '@/components/ui/cn';
import { vinRequestHref } from '@/lib/vin-link';

interface Advantage {
  key: string;
  icon: ReactNode;
  title: string;
  /** Where the tile leads: the page that explains or does what it says. */
  href: string;
}

/**
 * The white glyph of a tile: 40 px, 48 px from lg — two elements, so both keep the one
 * on-screen line of every big icon (icons/index.tsx, LARGE_LINE_PX).
 */
function glyph(Icon: IconComponent): ReactNode {
  return (
    <>
      <Icon size={40} className="lg:hidden" />
      <Icon size={48} className="hidden lg:block" />
    </>
  );
}

/** The part of /about that explains the advantages (SectionHeading id there). */
const ABOUT_WHY = '/about#about-why';

/** No-break space: «по VIN», «при получении» never part at the line end. */
const NB = '\u00a0';

const ADVANTAGES: readonly Advantage[] = [
  // The condition (only for parts in Orenburg) is on every stock badge; the tile stays short.
  {
    key: 'cod',
    icon: glyph(IconWallet),
    title: `Оплата при${NB}получении`,
    href: ABOUT_WHY,
  },
  {
    key: 'date',
    icon: glyph(IconCalendar),
    title: 'Точная дата прибытия',
    href: ABOUT_WHY,
  },
  {
    key: 'vin',
    icon: glyph(IconSts),
    title: `Подбор по${NB}VIN бесплатно`,
    href: vinRequestHref(),
  },
  {
    key: 'install',
    // A wrench like the other line glyphs (installation is a wrench everywhere). The tile
    // offers the option, not a garage (decision of 08.10): installing is the pickup
    // service's own job, paid there — the card at /about#pickup says so.
    icon: glyph(IconWrench),
    title: 'Можно сразу установить',
    href: '/about#pickup',
  },
  { key: 'return', icon: glyph(IconReturn), title: 'Возврат 7 дней', href: '/returns' },
  {
    key: 'receipt',
    icon: glyph(IconReceipt),
    title: 'Чек на каждую покупку',
    href: ABOUT_WHY,
  },
];

/**
 * The dark panel (docs/design-v2.md, DarkPanel): `bg-dark rounded-panel`, the white title
 * «{BRAND_NAME} — запчасти без сюрпризов» (the brand from env; the shop is an independent store,
 * decision of 08.10), six `dark-2` tiles with a white glyph and a short caption. Each tile is a
 * link (a tile that looks like the category tiles above must lead where it says): VIN to the
 * request, installation to the pickup point, return to /returns, the rest to «Почему у нас» on
 * /about where each one is explained. No chevrons (six arrows turned the panel into a settings
 * menu): a lighter fill and the −2 px lift of the tiles show it is clickable, with a white focus
 * ring. Phones: the
 * title over a 2×3 grid (three columns of ~100 px broke every caption word by word), 3×2 from
 * sm; desktop: the title on the left, the tiles 3×2 on the right.
 */
export function WhyUs({ brandName, className }: { brandName: string; className?: string }) {
  return (
    <section
      aria-labelledby="why-title"
      data-testid="home-why"
      className={cn(
        'grid min-w-0 gap-6 rounded-panel bg-dark p-4 pt-7 text-on-brand',
        'sm:p-6 md:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.2fr)] lg:items-center lg:gap-12 lg:p-12',
        className,
      )}
    >
      <h2 id="why-title" className="min-w-0 px-2 text-h2 text-balance sm:px-0">
        {brandName}
        {/* No-break space: the dash never starts a line. */}
        {'\u00a0— '}
        запчасти без сюрпризов
      </h2>
      <ul className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 md:gap-3">
        {ADVANTAGES.map((item) => (
          <li key={item.key} data-testid={`home-why-${item.key}`} className="min-w-0">
            <Link
              href={item.href}
              prefetch={false}
              className={cn(
                'flex h-full min-w-0 flex-col items-center gap-3 rounded-tile bg-dark-2 px-3 pt-5 pb-4 text-center text-on-brand',
                'transition-[background-color,transform] duration-150 hover:-translate-y-0.5 hover:bg-on-brand/10',
                'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-on-brand',
                'md:pt-6 md:pb-5 lg:gap-4 lg:pt-7 lg:pb-6',
              )}
            >
              <span aria-hidden className="grid size-10 place-items-center lg:size-12">
                {item.icon}
              </span>
              {/* wrap-anywhere: a long point name from env still stays inside the tile. */}
              <span className="max-w-full min-w-0 text-base leading-5 font-semibold wrap-anywhere">
                {item.title}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
