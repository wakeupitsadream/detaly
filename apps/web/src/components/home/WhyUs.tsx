import type { ReactNode } from 'react';
import {
  IconCalendar,
  IconReceipt,
  IconReturn,
  IconSts,
  IconWallet,
  IconWrench,
} from '@/components/icons';
import { cn } from '@/components/ui/cn';

interface Advantage {
  key: string;
  icon: ReactNode;
  title: string;
}

/** The white glyph of a tile: 40 px, 48 px from lg (CSS size wins over the attribute). */
const ICON = { size: 40, strokeWidth: 1.5, className: 'lg:size-12' } as const;

/** No-break space: «по VIN», «при получении», «в Сервис56» never part at the line end. */
const NB = '\u00a0';

function advantages(pickupName: string | null, emblemSrc: string | null): Advantage[] {
  return [
    // The condition (only for parts in Orenburg) is on every stock badge; the tile stays short.
    { key: 'cod', icon: <IconWallet {...ICON} />, title: `Оплата при${NB}получении` },
    { key: 'date', icon: <IconCalendar {...ICON} />, title: 'Точная дата прибытия' },
    { key: 'vin', icon: <IconSts {...ICON} />, title: `Подбор по${NB}VIN бесплатно` },
    {
      key: 'install',
      icon: emblemSrc ? (
        // A plain img: the partner's white emblem, a small WebP from public/.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={emblemSrc}
          alt=""
          width={240}
          height={146}
          loading="lazy"
          decoding="async"
          className="size-10 object-contain lg:size-12"
        />
      ) : (
        <IconWrench {...ICON} />
      ),
      title: pickupName ? `Установка в${NB}${pickupName}` : 'Установка в автосервисе',
    },
    { key: 'return', icon: <IconReturn {...ICON} />, title: 'Возврат 7 дней' },
    { key: 'receipt', icon: <IconReceipt {...ICON} />, title: 'Чек на каждую покупку' },
  ];
}

/**
 * The dark panel (docs/design-v2.md, DarkPanel): `bg-dark rounded-panel`, the white title with
 * the brand from env, six `dark-2` tiles with a white glyph and a short caption. Phones: the
 * title over a 2×3 grid (three columns of ~100 px broke every caption word by word), 3×2 from
 * sm; desktop: the title on the left, the tiles 3×2 on the right.
 */
export function WhyUs({
  brandName,
  pickupName,
  emblemSrc,
  className,
}: {
  brandName: string;
  pickupName: string | null;
  emblemSrc: string | null;
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
        {advantages(pickupName, emblemSrc).map((item) => (
          <li
            key={item.key}
            data-testid={`home-why-${item.key}`}
            className="flex min-w-0 flex-col items-center gap-3 rounded-tile bg-dark-2 px-3 pt-5 pb-4 text-center md:pt-6 md:pb-5 lg:gap-4 lg:pt-7 lg:pb-6"
          >
            <span aria-hidden className="grid size-10 place-items-center lg:size-12">
              {item.icon}
            </span>
            {/* wrap-anywhere: a long point name from env still stays inside the tile. */}
            <span className="max-w-full min-w-0 text-base leading-5 font-semibold wrap-anywhere">
              {item.title}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
