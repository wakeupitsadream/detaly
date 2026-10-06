import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import {
  IconBox,
  IconChevronDown,
  IconClock,
  IconDocument,
  IconPhone,
  IconPin,
  IconShield,
  IconWallet,
} from '@/components/icons';
import { LegalDocumentView } from '@/components/LegalDocumentView';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { buttonClass } from '@/components/ui/Button';
import { InfoCard } from '@/components/ui/Card';
import { SectionHeading } from '@/components/ui/Section';
import { getBrand, telHref } from '@/server/brand';
import { loadPublishedDocument, type LegalDocument } from '@/server/documents';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Возврат и обмен' };

/** The three steps, with icons (docs/design-v2.md, /returns). */
const STEPS: readonly { icon: ReactNode; title: string; text: string }[] = [
  {
    icon: <IconBox size={44} strokeWidth={1.5} className="md:size-14" />,
    title: 'Принесите деталь',
    text: 'В течение 7 дней, в упаковке.',
  },
  {
    icon: <IconShield size={44} strokeWidth={1.5} className="md:size-14" />,
    title: 'Мы проверим',
    text: 'Без следов установки — примем.',
  },
  {
    icon: <IconWallet size={44} strokeWidth={1.5} className="md:size-14" />,
    title: 'Деньги за 10 дней',
    text: 'Тем же способом, с чеком.',
  },
];

/** The rules, each under its own disclosure. */
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
] as const;

async function loadMemo(): Promise<LegalDocument | null> {
  try {
    return await loadPublishedDocument('return_memo');
  } catch (error) {
    getLogger().error({ err: error }, 'return memo unavailable');
    return null;
  }
}

/** A <details> row: a bold summary with a chevron, the text under it. */
function Disclosure({
  title,
  icon,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="details-plain group min-w-0 border-b border-line">
      <summary className="flex min-h-16 items-center gap-3 py-4 text-[1.0625rem] leading-snug font-bold hover:text-brand">
        {icon ? <span className="shrink-0 text-brand">{icon}</span> : null}
        <span className="min-w-0 flex-1">{title}</span>
        <IconChevronDown
          size={24}
          className="shrink-0 text-muted transition-transform duration-150 group-open:rotate-180"
        />
      </summary>
      <div className="min-w-0 pb-5">{children}</div>
    </details>
  );
}

/**
 * /returns (docs/design-v2.md, «Инфостраницы»): three steps with icons, where to bring the part,
 * then the rules and the full memo (the published return_memo document) under disclosures.
 */
export default async function ReturnsPage() {
  const brand = getBrand();
  const memo = await loadMemo();
  const { pickup } = brand;
  return (
    <InnerPage>
      <PageBand
        tone="light"
        title="Возврат и обмен"
        lead="7 дней на возврат. Без удержаний при самовывозе."
      />
      <PageBody className="space-y-12 md:space-y-16">
        <section aria-label="Как вернуть деталь" className="min-w-0">
          <ol className="grid min-w-0 gap-3 md:grid-cols-3 md:gap-4">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                className="flex min-w-0 items-center gap-4 rounded-tile bg-surface p-4 md:flex-col md:items-start md:gap-5 md:p-6"
              >
                <span
                  aria-hidden
                  className="relative grid size-20 shrink-0 place-items-center rounded-tile bg-bg text-brand md:size-24"
                >
                  {step.icon}
                  <span className="absolute -top-2 -left-2 grid size-8 place-items-center rounded-full bg-brand text-base font-extrabold text-on-brand tabular-nums">
                    {index + 1}
                  </span>
                </span>
                <div className="min-w-0">
                  <h2 className="text-h3">{step.title}</h2>
                  <p className="mt-1 text-small font-normal text-muted">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <InfoCard
          title="Куда принести"
          titleId="returns-where"
          aria-labelledby="returns-where"
          icon={<IconPin size={40} strokeWidth={1.5} />}
        >
          <div className="flex min-w-0 flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <ul className="min-w-0 space-y-2 text-body">
              <li className="font-semibold wrap-anywhere">
                {pickup.name ? `${pickup.name}, ` : null}
                {pickup.address ?? 'Адрес уточните по телефону'}
              </li>
              {pickup.hours ? (
                <li className="flex items-center gap-2 text-muted">
                  <IconClock size={22} className="shrink-0 text-brand" />
                  {pickup.hours}
                </li>
              ) : null}
            </ul>
            {brand.contactPhone ? (
              <a
                className={buttonClass({ variant: 'primary', size: 'lg' })}
                href={telHref(brand.contactPhone)}
              >
                <IconPhone size={20} />
                <span className="whitespace-nowrap tabular-nums">{brand.contactPhone}</span>
              </a>
            ) : null}
          </div>
        </InfoCard>

        <section aria-labelledby="returns-rules" className="min-w-0 max-w-3xl">
          <SectionHeading id="returns-rules">Подробно</SectionHeading>
          <div className="mt-4 border-t border-line">
            {RULES.map((rule) => (
              <Disclosure key={rule.title} title={rule.title}>
                <p className="text-body text-muted">{rule.text}</p>
              </Disclosure>
            ))}
            {memo ? (
              <Disclosure title="Полная памятка о возврате" icon={<IconDocument size={24} />}>
                <LegalDocumentView doc={memo} embedded />
              </Disclosure>
            ) : null}
          </div>
        </section>
      </PageBody>
    </InnerPage>
  );
}
