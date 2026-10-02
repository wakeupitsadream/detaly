import type { Metadata } from 'next';
import { IconClock, IconMessage, IconPhone, IconPin, IconShield } from '@/components/icons';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { getBrand, telHref } from '@/server/brand';

export const metadata: Metadata = { title: 'Подбор запчастей по VIN' };

/** A sample VIN to show what the 17 characters look like; not anybody's car. */
const SAMPLE_VIN = 'XTA210990Y1234567';

const VIN_PARTS = [
  { from: 0, to: 3, label: 'Завод' },
  { from: 3, to: 9, label: 'Модель и комплектация' },
  { from: 9, to: 17, label: 'Год и номер кузова' },
] as const;

const STEPS = [
  {
    title: 'Найдите VIN',
    text: '17 символов в свидетельстве о регистрации (СТС) или на табличке под лобовым стеклом.',
  },
  {
    title: 'Позвоните или приезжайте',
    text: 'Назовите VIN и какая деталь нужна. Можно показать СТС или старую деталь.',
  },
  {
    title: 'Получите варианты',
    text: 'Мастер пришлёт подходящие детали с ценой и датой получения.',
  },
] as const;

/** The 17 characters of a VIN as cells of a data plate, grouped by what they mean. */
function VinPlate() {
  return (
    <figure className="min-w-0 rounded border border-line bg-card p-4 md:p-6">
      <figcaption className="text-label text-muted">Так выглядит VIN</figcaption>
      <div className="mt-4 grid grid-cols-[repeat(17,minmax(0,1fr))] gap-px overflow-hidden rounded-sm border border-ink bg-ink">
        {SAMPLE_VIN.split('').map((char, index) => (
          <span
            key={index}
            className={cn(
              'grid h-9 place-items-center bg-card font-mono text-[0.8125rem] font-semibold md:h-12 md:text-lg',
              index < 3 && 'bg-accent-soft',
            )}
          >
            {char}
          </span>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-[repeat(17,minmax(0,1fr))] gap-px">
        {VIN_PARTS.map((part) => (
          <p
            key={part.label}
            className="border-t-2 border-ink pt-1.5 text-[0.6875rem] leading-tight text-muted md:text-xs"
            style={{ gridColumn: `${part.from + 1} / ${part.to + 1}` }}
          >
            {part.label}
          </p>
        ))}
      </div>
    </figure>
  );
}

/** The chat link with a ready first line, so the client only adds the photo. */
function telegramWithText(url: string | null): string | null {
  if (!url) return null;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}text=${encodeURIComponent('Нужна деталь по VIN: ')}`;
}

// Phase 0: no online form. Forms that collect personal data appear only after the
// notification to Roskomnadzor is registered (PLAN, decision 14).
export default function VinPage() {
  const brand = getBrand();
  const { pickup } = brand;
  const telegram = telegramWithText(brand.pickupLinks?.telegram ?? null);
  return (
    <InnerPage>
      <PageBand
        eyebrow="Не знаете артикул"
        title="Подбор запчастей по VIN — бесплатно"
        lead="Мастер подберёт деталь под ваш автомобиль по VIN. Если подобрали мы и деталь не подошла к автомобилю из заявки — вернём деньги полностью."
      />
      <PageBody>
        <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-16">
          <div className="min-w-0 space-y-10">
            <section aria-labelledby="vin-how" className="min-w-0">
              <h2 id="vin-how" className="text-h2">
                Как прислать запрос
              </h2>
              <ol className="mt-6 min-w-0 md:mt-8">
                {STEPS.map((step, index) => (
                  <li key={step.title} className="flex min-w-0 gap-4">
                    <div className="flex flex-col items-center">
                      <span className="grid size-9 shrink-0 place-items-center rounded-sm bg-ink font-mono text-xs font-semibold text-paper">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      {index < STEPS.length - 1 ? (
                        <span aria-hidden className="my-1 w-px flex-1 bg-line-strong" />
                      ) : null}
                    </div>
                    <div className={cn('min-w-0 pt-1.5', index < STEPS.length - 1 && 'pb-7')}>
                      <h3 className="text-h3">{step.title}</h3>
                      <p className="mt-1 text-muted">{step.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <VinPlate />
          </div>

          {/* Phones: the call comes right under the title, before the steps. */}
          <aside className="min-w-0 space-y-5 max-lg:order-first" aria-label="Контакты для запроса">
            <section className="grain-dark min-w-0 rounded border border-graphite-700 bg-graphite-900 bg-blueprint p-5 text-steel-200 md:p-6">
              <h2 className="text-label text-steel-400">Телефон</h2>
              {brand.contactPhone ? (
                <a
                  className="mt-2 block font-display text-2xl font-semibold text-paper wrap-anywhere hover:text-accent"
                  href={telHref(brand.contactPhone)}
                  data-testid="vin-phone"
                >
                  {brand.contactPhone}
                </a>
              ) : (
                <p className="mt-2 text-steel-400">уточняется</p>
              )}
              {brand.contactPhone ? (
                <a
                  className={cn(
                    buttonClass({ variant: 'primary', onDark: true, block: true }),
                    'mt-5',
                  )}
                  href={telHref(brand.contactPhone)}
                >
                  <IconPhone size={18} />
                  Позвонить мастеру
                </a>
              ) : null}
              {telegram ? (
                <a
                  className={cn(
                    buttonClass({ variant: 'secondary', onDark: true, block: true }),
                    'mt-3',
                  )}
                  href={telegram}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="vin-telegram"
                >
                  <IconMessage size={18} />
                  Отправить фото СТС в Telegram
                </a>
              ) : null}
              <div className="mt-6 border-t border-graphite-700 pt-5">
                <h2 className="text-label text-steel-400">
                  Пункт выдачи{pickup.name ? ` «${pickup.name}»` : ''}
                </h2>
                <p
                  className="mt-2 flex items-start gap-2 text-paper wrap-anywhere"
                  data-testid="vin-address"
                >
                  <IconPin size={17} className="mt-1 shrink-0 text-accent" />
                  <span className="min-w-0">{pickup.address ?? 'Адрес уточняется'}</span>
                </p>
                {pickup.hours ? (
                  <p className="mt-2 flex items-center gap-2 text-sm text-steel-400">
                    <IconClock size={15} className="shrink-0" />
                    {pickup.hours}
                  </p>
                ) : null}
              </div>
            </section>

            <section className="min-w-0 rounded border border-line bg-card p-5 md:p-6">
              <div className="flex items-start gap-3">
                <IconShield size={24} className="shrink-0 text-ok" />
                <div className="min-w-0">
                  <h2 className="text-h3">Подобрали мы&nbsp;— отвечаем мы</h2>
                  <p className="mt-2 text-sm text-muted">
                    Если деталь, подобранная мастером по VIN, не подошла к автомобилю из заявки,
                    вернём деньги полностью.
                  </p>
                </div>
              </div>
            </section>
          </aside>
        </div>
      </PageBody>
    </InnerPage>
  );
}
