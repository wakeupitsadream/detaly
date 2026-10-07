import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  IconCalendar,
  IconChevron,
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

/** The white glyph of a tile: 40 px, 48 px from lg (CSS size wins over the attribute). */
const ICON = { size: 40, strokeWidth: 1.5, className: 'lg:size-12' } as const;

/** No-break space: «по VIN», «при получении», «в Сервис56» never part at the line end. */
const NB = '\u00a0';

function advantages(pickupName: string | null): Advantage[] {
  return [
    // The condition (only for parts in Orenburg) is on every stock badge; the tile stays short.
    {
      key: 'cod',
      icon: <IconWallet {...ICON} />,
      title: `Оплата при${NB}получении`,
      href: '/about',
    },
    {
      key: 'date',
      icon: <IconCalendar {...ICON} />,
      title: 'Точная дата прибытия',
      href: '/about',
    },
    {
      key: 'vin',
      icon: <IconSts {...ICON} />,
      title: `Подбор по${NB}VIN бесплатно`,
      href: vinRequestHref(),
    },
    {
      key: 'install',
      // A wrench like the other line glyphs (installation is a wrench everywhere): the
      // partner's filled emblem stood out of the row.
      icon: <IconWrench {...ICON} />,
      title: pickupName ? `Установка в${NB}${pickupName}` : `Установка в${NB}автосервисе`,
      href: '/about#pickup',
    },
    { key: 'return', icon: <IconReturn {...ICON} />, title: 'Возврат 7 дней', href: '/returns' },
    {
      key: 'receipt',
      icon: <IconReceipt {...ICON} />,
      title: 'Чек на каждую покупку',
      href: '/about',
    },
  ];
}

/**
 * The dark panel (docs/design-v2.md, DarkPanel): `bg-dark rounded-panel`, the white title with
 * the brand from env, six `dark-2` tiles with a white glyph and a short caption. Each tile is a
 * link (a tile that looks like the category tiles above must lead where it says): VIN to the
 * request, installation to the pickup point, return to /returns, the rest to /about where the
 * advantages are explained; a small chevron, a lighter hover and a white focus ring. Phones: the
 * title over a 2×3 grid (three columns of ~100 px broke every caption word by word), 3×2 from
 * sm; desktop: the title on the left, the tiles 3×2 on the right.
 */
export function WhyUs({
  brandName,
  pickupName,
  className,
}: {
  brandName: string;
  pickupName: string | null;
  className?: string;
}) {
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
        запчасти от тех, кто их ставит
      </h2>
      <ul className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 md:gap-3">
        {advantages(pickupName).map((item) => (
          <li key={item.key} data-testid={`home-why-${item.key}`} className="min-w-0">
            <Link
              href={item.href}
              prefetch={false}
              className={cn(
                'group relative flex h-full min-w-0 flex-col items-center gap-3 rounded-tile bg-dark-2 px-3 pt-5 pb-4 text-center text-on-brand',
                'transition-colors duration-150 hover:bg-on-brand/12',
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
              <IconChevron
                size={18}
                className="absolute top-3 right-3 opacity-60 transition-opacity group-hover:opacity-100"
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
