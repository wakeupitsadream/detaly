'use client';

import { useState } from 'react';
import { IconArrowRight } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/components/ui/cn';
import { PartTile } from '@/components/ui/PartTile';
import { Price } from '@/components/ui/Price';
import type { InstallShowcase } from '@/server/install';
import { InstallChain } from './InstallChain';
import { InstallFormulaSheet } from './InstallFormulaSheet';
import { LiftLoadStrip } from './LiftLoadStrip';

/**
 * The interactive "when will the car be ready" card: article chips switch the example, the
 * chain redraws, the lift board shows the slot day. All numbers come precomputed from the
 * server (server/install planInstallShowcase); the client only switches between them.
 */
export function InstallWindowDemo({ showcase }: { showcase: InstallShowcase }) {
  const [index, setIndex] = useState(0);
  const item = showcase.items[index] ?? showcase.items[0]!;
  const offer = item.offer;

  return (
    <div className="corner-marks min-w-0 rounded border border-line bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 md:px-6">
        {showcase.kind === 'examples' && showcase.items.length > 1 ? (
          <div
            role="group"
            aria-label="Пример по артикулу"
            className="flex min-w-0 flex-wrap gap-1.5"
          >
            {showcase.items.map((it, i) => (
              <button
                key={it.key}
                type="button"
                aria-pressed={i === index}
                onClick={() => setIndex(i)}
                className={cn(
                  'h-9 rounded-sm border px-3 font-mono text-sm font-semibold tracking-wide transition-colors duration-150',
                  i === index
                    ? 'border-ink bg-ink text-paper'
                    : 'border-line bg-card text-ink hover:border-ink',
                )}
              >
                {it.offer?.article ?? it.key}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-label text-muted">Пример расчёта</span>
        )}
        {showcase.demo ? <Badge tone="demo">загрузка демонстрационная</Badge> : null}
      </div>

      <div className="flex min-w-0 items-center gap-4 px-4 pt-5 md:px-6 md:pt-6">
        <PartTile name={offer?.name ?? 'фильтр'} size="sm" />
        <div className="min-w-0 flex-1">
          {offer ? (
            <>
              <p className="text-label text-muted">{offer.brand}</p>
              <p className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-3">
                <span className="text-article wrap-anywhere">{offer.article}</span>
                <span className="min-w-0 truncate text-sm text-muted">{offer.name}</span>
              </p>
            </>
          ) : (
            <>
              <p className="text-label text-muted">Склад в Оренбурге</p>
              <p className="mt-0.5 font-semibold">Деталь, которая уже в городе</p>
            </>
          )}
        </div>
        {offer ? (
          <div className="hidden shrink-0 text-right sm:block">
            <Price size="sm">{offer.priceText}</Price>
            <p className="mt-1 text-xs text-muted">{offer.isLocal ? 'в Оренбурге' : 'под заказ'}</p>
          </div>
        ) : null}
      </div>

      {/* key: a new example redraws the chain line. */}
      <div key={item.key} className="px-4 pt-6 pb-2 md:px-6 md:pt-8">
        <InstallChain
          data={{
            partText: item.view.partText,
            slotText: item.view.slotText,
            slotDayText: item.slotDayText,
            carReadyText: item.view.carReadyText,
            slotStartIso: item.view.slotStartIso,
          }}
        />
      </div>

      <div className="mx-4 mt-6 border-t border-dashed border-line-strong pt-5 md:mx-6">
        <LiftLoadStrip hours={item.strip} dayText={item.slotDayText} />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-line px-4 py-2 md:px-6">
        <InstallFormulaSheet demo={showcase.demo} />
        <a
          href="#search-q"
          className="group inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-accent-ink"
        >
          Посчитать для своей детали
          <IconArrowRight
            size={18}
            className="transition-transform duration-150 group-hover:translate-x-0.5"
          />
        </a>
      </div>
    </div>
  );
}
