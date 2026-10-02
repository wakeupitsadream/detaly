import { IconArrowRight, IconSearch, IconShield } from '@/components/icons';
import { ButtonLink } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { Eyebrow } from '@/components/ui/Eyebrow';

const WHERE_TO_FIND = [
  {
    title: 'На старой детали',
    text: 'Номер выбит или напечатан на корпусе, рядом с логотипом производителя.',
  },
  {
    title: 'В заказ-наряде',
    text: 'Сервис пишет артикулы в документах прошлого ремонта.',
  },
  {
    title: 'В каталоге производителя',
    text: 'По марке, модели и году выпуска на сайте производителя детали.',
  },
];

/**
 * Two ways in: "I know the article" (where to find it, then the search in the hero) and "I do
 * not" (VIN, with the money-back rule). No second search form here: the page keeps one
 * «Артикул детали» field.
 */
export function ArticleOrVin({ className }: { className?: string }) {
  return (
    <div className={cn('grid min-w-0 gap-4 lg:grid-cols-[1.25fr_1fr] lg:gap-6', className)}>
      <section
        aria-labelledby="know-title"
        className="min-w-0 rounded border border-line bg-card p-6 md:p-8"
      >
        <Eyebrow>Знаю артикул</Eyebrow>
        <h3 id="know-title" className="mt-4 text-h2">
          Наберите номер — цена и дата сразу
        </h3>
        <ol className="mt-6 grid gap-x-6 gap-y-5 md:grid-cols-3">
          {WHERE_TO_FIND.map((item, index) => (
            <li key={item.title} className="min-w-0 border-t-2 border-ink pt-3">
              <p className="font-mono text-xs font-semibold text-accent-ink">
                {String(index + 1).padStart(2, '0')}
              </p>
              <p className="mt-1 font-semibold">{item.title}</p>
              <p className="mt-1 text-sm text-muted">{item.text}</p>
            </li>
          ))}
        </ol>
        <a
          href="#search-q"
          className="group mt-8 inline-flex min-h-11 items-center gap-2 font-semibold underline decoration-1 underline-offset-4 hover:decoration-2"
        >
          <IconSearch size={18} />
          К поиску по артикулу
          <IconArrowRight
            size={18}
            className="-rotate-90 transition-transform duration-150 group-hover:-translate-y-0.5"
          />
        </a>
      </section>

      <section
        aria-labelledby="vin-title"
        className="grain-dark min-w-0 overflow-hidden rounded bg-graphite-900 p-6 text-steel-200 md:p-8"
      >
        <Eyebrow onDark>Не знаю артикул</Eyebrow>
        <h3 id="vin-title" className="mt-4 text-h2 text-paper">
          Пришлите VIN — подберём сами
        </h3>
        <p className="mt-4 max-w-md text-steel-200">
          Мастер бесплатно подберёт деталь под вашу машину по VIN из СТС и пришлёт варианты с ценой
          и датой получения.
        </p>
        <div className="mt-6 flex min-w-0 items-start gap-3 rounded-sm border border-graphite-700 bg-graphite-950/60 p-4">
          <IconShield size={22} className="mt-0.5 shrink-0 text-accent" />
          <p className="min-w-0 text-[0.9375rem] text-paper">
            Подобрали мы и не подошло — вернём деньги.
          </p>
        </div>
        <ButtonLink href="/vin" onDark size="lg" className="mt-8">
          Как прислать VIN
          <IconArrowRight size={18} />
        </ButtonLink>
      </section>
    </div>
  );
}
