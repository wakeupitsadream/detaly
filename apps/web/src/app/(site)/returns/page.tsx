import type { Metadata } from 'next';
import { IconPhone, IconPin, IconShield } from '@/components/icons';
import { LegalDocumentView } from '@/components/LegalDocumentView';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { getBrand, telHref } from '@/server/brand';
import { loadPublishedDocument, type LegalDocument } from '@/server/documents';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Возврат и обмен' };

/** The three numbers a client asks about first, set large in the band. */
const FACTS = [
  { value: '7 дней', label: 'на возврат исправной детали' },
  { value: '0 ₽', label: 'удержаний при самовывозе' },
  { value: '10 дней', label: 'чтобы деньги вернулись' },
] as const;

const RULES = [
  {
    title: '7 дней на возврат исправной детали',
    text: 'Не подошла или передумали — верните в течение 7 дней со дня получения. Нужны товарный вид, упаковка и отсутствие следов установки.',
  },
  {
    title: 'Без удержаний при самовывозе',
    text: 'Деньги возвращаем полностью. До получения от заказа можно отказаться в любой момент.',
  },
  {
    title: 'Деньги — в течение 10 дней',
    text: 'Тем же способом, которым вы платили, с чеком возврата. Наличными возврат не выдаём.',
  },
  {
    title: 'Брак — по гарантии',
    text: 'Замена, уменьшение цены или возврат денег. Сохраните деталь и упаковку, фото дефекта ускорят решение.',
  },
  {
    title: 'Подобрали мы — и не подошло',
    text: 'Если деталь подбирал наш мастер по VIN и она не подошла к автомобилю из заявки, вернём деньги полностью.',
  },
];

async function loadMemo(): Promise<LegalDocument | null> {
  try {
    return await loadPublishedDocument('return_memo');
  } catch (error) {
    getLogger().error({ err: error }, 'return memo unavailable');
    return null;
  }
}

export default async function ReturnsPage() {
  const brand = getBrand();
  const memo = await loadMemo();
  const { pickup } = brand;
  return (
    <InnerPage>
      <PageBand
        eyebrow="Гарантии и возврат"
        title="Возврат и обмен"
        lead="Коротко и по-человечески. Полная памятка — ниже."
      >
        <dl className="grid min-w-0 grid-cols-1 border-t border-graphite-700 sm:grid-cols-3">
          {FACTS.map((fact, index) => (
            <div
              key={fact.value}
              className={cn(
                'flex min-w-0 items-baseline gap-4 border-b border-graphite-700 py-4 sm:flex-col sm:items-start sm:gap-3 sm:border-b-0 sm:py-6',
                index > 0 && 'sm:border-l sm:pl-6',
              )}
            >
              <dt className="order-2 text-sm text-steel-400 md:text-base">{fact.label}</dt>
              <dd className="order-1 shrink-0 font-display text-3xl leading-none font-bold text-paper tabular-nums md:text-5xl">
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </PageBand>

      <PageBody className="space-y-12 md:space-y-16">
        <ol className="grid min-w-0 gap-px overflow-hidden rounded border border-line bg-line md:grid-cols-2">
          {RULES.map((rule, index) => (
            <li key={rule.title} className="min-w-0 bg-card p-5 md:p-7">
              <span className="font-mono text-xs font-semibold text-accent-ink">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h2 className="mt-3 text-h3">{rule.title}</h2>
              <p className="mt-2 text-muted">{rule.text}</p>
            </li>
          ))}
          <li className="grain-dark min-w-0 bg-graphite-900 p-5 text-steel-200 md:p-7">
            <span className="inline-flex items-center gap-2 text-label text-steel-400">
              <IconShield size={16} className="text-accent" />
              Как вернуть
            </span>
            <h2 className="mt-3 text-h3 text-paper">Принесите деталь в пункт выдачи</h2>
            <p className="mt-2 flex items-start gap-2">
              <IconPin size={18} className="mt-0.5 shrink-0 text-steel-400" />
              <span className="min-w-0 wrap-anywhere">
                {pickup.address ?? 'Адрес уточните по телефону'}
                {pickup.hours ? (
                  <span className="block text-sm text-steel-400">{pickup.hours}</span>
                ) : null}
              </span>
            </p>
            {brand.contactPhone ? (
              <a
                className={cn(buttonClass({ variant: 'secondary', onDark: true }), 'mt-5')}
                href={telHref(brand.contactPhone)}
              >
                <IconPhone size={17} />
                Позвонить в пункт выдачи {brand.contactPhone}
              </a>
            ) : null}
          </li>
        </ol>

        {memo ? (
          <section aria-label="Памятка о возврате" className="min-w-0">
            <Eyebrow className="mb-4">Полная памятка</Eyebrow>
            <LegalDocumentView doc={memo} sheet />
          </section>
        ) : null}
      </PageBody>
    </InnerPage>
  );
}
