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
  /** A second, quieter line: the condition of the promise. */
  note?: string;
}

/** The 40 px white glyph of a tile. */
const ICON = { size: 40, strokeWidth: 1.5 } as const;

function advantages(pickupName: string | null, emblemSrc: string | null): Advantage[] {
  return [
    {
      key: 'cod',
      icon: <IconWallet {...ICON} />,
      title: 'Оплата при получении',
      note: 'если деталь в городе',
    },
    { key: 'date', icon: <IconCalendar {...ICON} />, title: 'Точная дата прибытия' },
    { key: 'vin', icon: <IconSts {...ICON} />, title: 'Подбор по VIN бесплатно' },
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
          className="h-10 w-auto"
        />
      ) : (
        <IconWrench {...ICON} />
      ),
      title: pickupName ? `Установка в ${pickupName}` : 'Установка в автосервисе',
    },
    { key: 'return', icon: <IconReturn {...ICON} />, title: 'Возврат 7 дней' },
    { key: 'receipt', icon: <IconReceipt {...ICON} />, title: 'Чек на каждую покупку' },
  ];
}

/**
 * The dark panel (docs/design-v2.md, DarkPanel): `bg-dark rounded-panel`, the white title with
 * the brand from env, six `dark-2` tiles with a white glyph and a short caption. Phones: the
 * title over a 3×2 grid; desktop: the title on the left, the tiles 3×2 on the right.
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
        'sm:p-6 md:p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:items-center lg:gap-10 lg:p-10',
        className,
      )}
    >
      <h2 id="why-title" className="min-w-0 px-2 text-h2 text-balance sm:px-0">
        {brandName}
        {/* No-break space: the dash never starts a line. */}
        {'\u00a0— '}
        запчасти от тех, кто их ставит
      </h2>
      <ul className="grid min-w-0 grid-cols-3 gap-2 md:gap-3">
        {advantages(pickupName, emblemSrc).map((item) => (
          <li
            key={item.key}
            data-testid={`home-why-${item.key}`}
            className="flex min-w-0 flex-col items-center gap-3 rounded-tile bg-dark-2 px-1.5 pt-5 pb-4 text-center md:px-3 md:pt-6 md:pb-5"
          >
            <span aria-hidden className="grid h-10 place-items-center">
              {item.icon}
            </span>
            <span className="min-w-0 text-base leading-5 font-semibold text-balance hyphens-auto">
              {item.title}
              {item.note ? (
                <span className="mt-1 block text-sm leading-[1.125rem] font-medium text-on-brand/75">
                  {item.note}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
