import Link from 'next/link';
import type { ReactNode } from 'react';
import { IconClock, IconPhone, IconPin } from '@/components/icons';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { Section } from '@/components/ui/Section';
import type { Brand } from '@/server/brand';
import { telHref } from '@/server/brand';
import { PickupSchematic } from './PickupSchematic';

function Row({ icon, term, children }: { icon: ReactNode; term: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 border-t border-graphite-700 py-4">
      <span className="mt-0.5 text-accent">{icon}</span>
      <div className="min-w-0">
        <dt className="text-label text-steel-400">{term}</dt>
        <dd className="mt-1 text-paper wrap-anywhere">{children}</dd>
      </div>
    </div>
  );
}

/**
 * The pickup point on graphite: name, address, hours and phone from env, a drawn schematic
 * instead of a map, and one line about the seller with a link to the requisites.
 */
export function PickupPointSection({ brand }: { brand: Brand }) {
  const { pickup, seller } = brand;
  return (
    <Section tone="dark" blueprint aria-labelledby="pickup-title">
      <div className="grid min-w-0 gap-10 lg:grid-cols-12 lg:gap-12">
        <div className="min-w-0 lg:col-span-5">
          <Eyebrow onDark>Точка выдачи</Eyebrow>
          <h2 id="pickup-title" className="mt-4 text-h2 text-paper">
            {pickup.name ?? 'Пункт выдачи в автосервисе'}
          </h2>
          <p className="mt-4 max-w-md text-steel-200">
            Выдаём заказы прямо в автосервисе. Забрали деталь — и, если записались, сразу на
            подъёмник.
          </p>
          <dl className="mt-8 border-b border-graphite-700">
            <Row icon={<IconPin size={20} />} term="Адрес">
              {pickup.address ?? 'уточняется'}
            </Row>
            <Row icon={<IconClock size={20} />} term="Часы">
              {pickup.hours ?? 'уточняются'}
            </Row>
            <Row icon={<IconPhone size={20} />} term="Телефон">
              {brand.contactPhone ? (
                <a
                  href={telHref(brand.contactPhone)}
                  className="font-mono whitespace-nowrap underline decoration-graphite-700 underline-offset-4 hover:decoration-accent"
                >
                  {brand.contactPhone}
                </a>
              ) : (
                'уточняется'
              )}
            </Row>
          </dl>
          <p className="mt-6 text-sm text-steel-400">
            Продавец — {seller.name ? `ИП ${seller.name}` : 'индивидуальный предприниматель'}.
            Возврат 7{' '}дней без удержаний при самовывозе.{' '}
            <Link
              href="/about"
              className="text-steel-200 underline underline-offset-4 hover:text-paper"
            >
              Реквизиты
            </Link>
          </p>
        </div>
        <PickupSchematic className="lg:col-span-7" />
      </div>
    </Section>
  );
}
