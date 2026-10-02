import type { CSSProperties, ReactNode } from 'react';
import { DemoDataBanner } from '@/components/DemoDataBanner';
import { IconArrowRight } from '@/components/icons';
import { SearchBar } from '@/components/SearchBar';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/components/ui/cn';
import { Container } from '@/components/ui/Container';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { PartTile } from '@/components/ui/PartTile';
import type { InstallShowcase } from '@/server/install';
import { HeroFacts, type HeroFact } from './HeroFacts';
import { InstallChain } from './InstallChain';

/** Staggered rise step (globals.css .rise). */
function step(i: number): CSSProperties {
  return { ['--i' as string]: i };
}

/** A line of the headline that rises on its own. */
function Line({ i, children }: { i: number; children: ReactNode }) {
  return (
    <span className="rise block" style={step(i)}>
      {children}
    </span>
  );
}

/** The hero ticket: the fastest example as a filled-in repair order. */
function HeroTicket({ showcase }: { showcase: InstallShowcase }) {
  const item = showcase.items[0]!;
  return (
    <div
      className="corner-marks rounded border border-graphite-700 bg-graphite-950/80 p-5 md:p-6"
      style={{ ['--corner-color' as string]: 'var(--color-steel-400)' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-graphite-700 pb-4">
        <p className="text-label text-steel-400">Заказ-наряд · пример</p>
        {showcase.demo ? <Badge tone="demo">демо</Badge> : null}
      </div>
      <div className="flex min-w-0 items-center gap-3 py-4">
        <PartTile
          name={item.offer?.name ?? null}
          size="sm"
          className="border border-graphite-700"
        />
        <div className="min-w-0">
          {item.offer ? (
            <>
              <p className="text-label text-steel-400">{item.offer.brand}</p>
              <p className="text-article text-paper wrap-anywhere">{item.offer.article}</p>
              <p className="truncate text-sm text-steel-400">{item.offer.name}</p>
            </>
          ) : (
            <>
              <p className="text-label text-steel-400">Склад в Оренбурге</p>
              <p className="font-semibold text-paper">Деталь, которая уже в городе</p>
            </>
          )}
        </div>
      </div>
      <InstallChain
        compact
        onDark
        data={{
          partText: item.view.partText,
          slotText: item.view.slotText,
          slotDayText: item.slotDayText,
          carReadyText: item.view.carReadyText,
          slotStartIso: item.view.slotStartIso,
        }}
      />
      <a
        href="#install"
        className="group mt-5 flex min-h-11 items-center justify-between gap-3 border-t border-graphite-700 pt-4 text-sm font-medium text-steel-200 hover:text-paper"
      >
        Как это посчитано
        <IconArrowRight
          size={18}
          className="rotate-90 text-accent transition-transform duration-150 group-hover:translate-y-0.5"
        />
      </a>
    </div>
  );
}

/**
 * Graphite hero on the drafting grid with a -4° cut at the bottom, the hazard tape lying on
 * the cut. One phrase about the install window, the search, the facts in figures, and the
 * ticket with the fastest example on the right (below the search on phones).
 */
export function Hero({
  showcase,
  facts,
  demoData,
}: {
  showcase: InstallShowcase | null;
  facts: readonly HeroFact[];
  demoData: boolean;
}) {
  return (
    <div className="relative isolate overflow-hidden">
      <section
        aria-labelledby="hero-title"
        className={cn(
          'grain-dark bg-graphite-900 bg-blueprint text-steel-200',
          // The bottom edge falls 4° to the left: tan(4°) ≈ 0.07 of the width.
          '[clip-path:polygon(0_0,100%_0,100%_calc(100%-7vw),0_100%)]',
        )}
      >
        <Container className="pt-10 pb-[calc(7vw+2.5rem)] md:pt-16 lg:pt-20">
          <Eyebrow onDark className="rise" style={step(0)}>
            Оренбург · автозапчасти с установкой
          </Eyebrow>
          {/* The headline runs across the whole column: three lines on a desktop. */}
          <h1 id="hero-title" className="mt-5 text-display text-paper">
            <Line i={1}>Узнайте, когда</Line>
            <Line i={2}>
              <span className="bg-[linear-gradient(var(--color-accent),var(--color-accent))] bg-[length:100%_0.14em] bg-[position:0_94%] bg-no-repeat box-decoration-clone">
                машина будет готова,
              </span>
            </Line>
            <Line i={3}>ещё до заказа детали</Line>
          </h1>
          <div className="mt-2 grid min-w-0 gap-10 lg:mt-4 lg:grid-cols-12 lg:gap-12">
            <div className="min-w-0 lg:col-span-7">
              <p
                className="rise mt-6 max-w-xl text-lg leading-relaxed text-steel-200"
                style={step(4)}
              >
                Цена, дата в Оренбурге и ближайшее окно на подъёмнике — сразу по артикулу.
              </p>
              <div className="rise mt-8 max-w-2xl" style={step(5)}>
                <SearchBar large onDark />
              </div>
              {demoData ? (
                <div className="rise mt-6 max-w-2xl" style={step(6)}>
                  <DemoDataBanner />
                </div>
              ) : null}
            </div>
            {showcase ? (
              <div className="rise min-w-0 lg:col-span-5 lg:pt-6" style={step(6)}>
                <HeroTicket showcase={showcase} />
              </div>
            ) : null}
          </div>
          <div className="rise mt-12 lg:mt-16" style={step(7)}>
            <HeroFacts facts={facts} />
          </div>
        </Container>
      </section>
      {/* Hazard tape on the cut line: centred on it, rotated with it. */}
      <div
        aria-hidden
        className="hazard absolute left-[-5%] h-2.5 w-[110%] -rotate-4"
        style={{ bottom: 'calc(3.5vw - 5px)' }}
      />
    </div>
  );
}
