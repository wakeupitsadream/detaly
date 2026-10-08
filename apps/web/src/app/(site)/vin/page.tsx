import { VIN_PHOTOS_MAX } from '@detaly/domain';
import type { Metadata } from 'next';
import {
  IconCart,
  IconClock,
  IconMessage,
  IconPhone,
  IconPin,
  IconShield,
  IconSts,
  IconWrench,
} from '@/components/icons';
import { PICKUP_ADDRESS_PENDING } from '@/components/PickupCard';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { buttonClass } from '@/components/ui/Button';
import { IconCard, InfoCard } from '@/components/ui/Card';
import { SectionHeading } from '@/components/ui/Section';
import { VinForm, type VinFormInitial } from '@/components/vin/VinForm';
import { PART_CATEGORIES } from '@/lib/part-categories';
import { PAGE_SEO } from '@/lib/seo';
import { VinPlate, VinSteps, VinWhereFold, type VinStep } from '@/components/vin/VinPlate';
import { vinFormInitial } from '@/components/vin/vin-query';
import { getBrand, telHref, type Brand } from '@/server/brand';
import { currentCheckoutGate } from '@/server/checkout-gate';
import { uuidV7 } from '@/server/checkout/uuid';
import { serverEnv } from '@/server/env';
import { photosEnabled } from '@/server/files';
import { isDemoMode } from '@/server/mode';
import { errorsOf, parseErrorCodes, VIN_FORM_MESSAGES } from '@/server/vin/form';

// The canonical drops ?vin, ?car and ?need: the home page links /vin with 48 of them.
export const metadata: Metadata = {
  title: PAGE_SEO.vin.title,
  description: PAGE_SEO.vin.description,
  alternates: { canonical: '/vin' },
};

// The form appears with the checkout gate (RKN number, documents, pickup point): runtime env
// and the database decide, so the page is rendered per request.
export const dynamic = 'force-dynamic';

const TITLE = 'Подбор по VIN';
/** The answer time is in the lead, so it shows always — the demo too (the line under the
 * button is about consent there). */
const LEAD = 'Мастер подберёт деталь и пришлёт цены — обычно за 4 часа в рабочее время. Бесплатно.';

/** The lead under the title when the visitor came with a choice (?car=, ?need=). */
const CHOSEN_LEAD = 'Впишите VIN — ответим обычно за 4 часа, бесплатно';

/** Longest «Нужно» chip before an ellipsis: the full text is in the form's field. */
const NEED_CHIP_MAX = 28;

/**
 * A short chip for what is needed: the category tile's title for a home-page category
 * (PART_CATEGORIES, «Фильтры» rather than «Фильтры для ТО: масляный, …»), else the text itself,
 * cut. The full need stays pre-filled in «Какая деталь нужна».
 */
function needChip(need: string): string {
  const category = PART_CATEGORIES.find((item) => item.need === need);
  if (category) return category.title;
  return need.length > NEED_CHIP_MAX ? `${need.slice(0, NEED_CHIP_MAX - 1).trimEnd()}…` : need;
}

/**
 * The choice from the home tiles (?car=, ?need=) as chips under the title — «Kia», «Фильтры» —
 * (VinBand puts one line of what is left to do under them), so the tap never looks lost on a
 * VIN form.
 */
function Chosen({ initial }: { initial: VinFormInitial }) {
  const chips = [
    initial.car ? { label: 'Марка', text: initial.car } : null,
    initial.need ? { label: 'Нужно', text: needChip(initial.need) } : null,
  ].filter((chip): chip is { label: string; text: string } => chip !== null);
  return (
    <ul className="flex min-w-0 flex-wrap gap-2" aria-label="Ваш выбор" data-testid="vin-chosen">
      {chips.map((chip) => (
        <li
          key={chip.label}
          className="inline-flex min-h-10 max-w-full min-w-0 items-center rounded-full bg-brand-soft px-4 text-small font-semibold text-ink"
        >
          <span className="sr-only">{chip.label}: </span>
          <span className="min-w-0 truncate">{chip.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** The title band: the plain lead, or the chosen chips with one line under them. */
function VinBand({ initial }: { initial: VinFormInitial }) {
  if (!initial.car && !initial.need) return <PageBand tone="light" title={TITLE} lead={LEAD} />;
  return (
    <PageBand tone="light" title={TITLE}>
      <Chosen initial={initial} />
      <p className="mt-3 text-body text-muted">{CHOSEN_LEAD}</p>
    </PageBand>
  );
}

/** Steps while there is no online form (phase 0 and a closed gate). */
const CALL_STEPS: readonly VinStep[] = [
  { icon: IconSts, title: 'Найдите VIN', text: 'Он есть в СТС.' },
  {
    icon: IconPhone,
    title: 'Позвоните',
    text: 'Назовите VIN и нужную деталь.',
  },
  {
    icon: IconWrench,
    title: 'Получите варианты',
    text: 'С ценой и датой получения.',
  },
];

/** Steps next to the form (phase 1C). */
const FORM_STEPS: readonly VinStep[] = [
  {
    icon: IconSts,
    title: 'Заявка',
    text: 'VIN и что нужно.',
  },
  {
    icon: IconWrench,
    title: 'Мастер подберёт',
    text: 'Пришлёт ссылку с ценами и датами.',
  },
  {
    icon: IconCart,
    title: 'Оформите',
    text: 'Как обычный заказ.',
  },
];

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The chat link with a ready first line, so the client only adds the photo. */
function telegramWithText(url: string | null): string | null {
  if (!url) return null;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}text=${encodeURIComponent('Нужна деталь по VIN: ')}`;
}

/** The address and hours of the pickup point, one line each with an icon. */
function PickupLines({ brand }: { brand: Brand }) {
  const { pickup } = brand;
  return (
    <ul className="space-y-2 text-body">
      <li className="flex items-start gap-2.5" data-testid="vin-address">
        <IconPin size={22} className="mt-0.5 shrink-0 text-brand" />
        <span className="min-w-0 wrap-anywhere">
          {pickup.name ? <span className="font-semibold">{pickup.name}, </span> : null}
          {pickup.address ?? PICKUP_ADDRESS_PENDING}
        </span>
      </li>
      {pickup.hours ? (
        <li className="flex items-start gap-2.5 text-muted">
          <IconClock size={22} className="mt-0.5 shrink-0 text-brand" />
          <span className="min-w-0">{pickup.hours}</span>
        </li>
      ) : null}
    </ul>
  );
}

/** The phone in large digits (data-testid="vin-phone"); nothing without one. */
function PhoneNumber({ phone }: { phone: string | null }) {
  if (!phone) return null;
  return (
    <a
      className="inline-flex min-h-11 items-center text-h2 whitespace-nowrap tabular-nums hover:text-brand"
      href={telHref(phone)}
      data-testid="vin-phone"
    >
      {phone}
    </a>
  );
}

/**
 * The phone of «Удобнее позвонить?» (data-testid="vin-phone"): on phones and tablets a
 * full-width secondary button «Позвонить +7 …» (a bare number did not look tappable), from lg
 * the large number under the card's phone icon.
 */
function CallButton({ phone }: { phone: string }) {
  return (
    <a
      className={[
        'inline-flex min-h-13 w-full min-w-0 items-center justify-center gap-2 rounded-control border-[1.5px] border-line-strong bg-bg px-5',
        'text-[1.0625rem] font-semibold whitespace-nowrap text-ink tabular-nums hover:border-ink hover:bg-surface',
        'lg:min-h-11 lg:w-auto lg:justify-start lg:gap-3 lg:border-0 lg:px-0 lg:text-h2 lg:hover:bg-transparent lg:hover:text-brand',
      ].join(' ')}
      href={telHref(phone)}
      data-testid="vin-phone"
    >
      {/* From lg the card's head has the phone icon already: the number stands alone. */}
      <IconPhone size={24} className="shrink-0 text-brand lg:hidden" />
      <span className="lg:hidden">Позвонить</span>
      {phone}
    </a>
  );
}

/** The VIN guarantee: the shield in the head of the same white card as the others. */
function Guarantee() {
  return (
    <IconCard icon={<IconShield size={24} />} title={'Подобрали мы\u00a0— отвечаем мы'}>
      <p className="text-small font-normal text-muted">
        Не подошла к машине из заявки — вернём деньги.
      </p>
    </IconCard>
  );
}

/** «Удобнее позвонить?» next to the form; without a phone there is no such card. */
function CallCard({ brand }: { brand: Brand }) {
  if (!brand.contactPhone) return null;
  return (
    <IconCard icon={<IconPhone size={24} />} title="Удобнее позвонить?" titleId="vin-call">
      <div className="space-y-4">
        <CallButton phone={brand.contactPhone} />
        <PickupLines brand={brand} />
      </div>
    </IconCard>
  );
}

/** What came in the query, shown on the closed gate so the visitor can say it on the phone. */
function AskedFor({ initial }: { initial: VinFormInitial }) {
  const rows = [
    ['VIN', initial.vin],
    ['Машина', initial.car],
    ['Нужно', initial.need],
  ].filter((row): row is [string, string] => Boolean(row[1]));
  if (rows.length === 0) return null;
  return (
    <dl
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-control bg-bg p-4 text-body"
      data-testid="vin-asked"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="font-semibold wrap-anywhere tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * /vin. With the checkout gate open (RKN number, published documents, pickup point; decision
 * С12) — the request form; otherwise the phase 0 page without a form (PLAN decision 14: no PD
 * form before the RKN notice): the phone, the address and the chat of the point in an InfoCard.
 * DEMO_MODE shows the form; its post never reaches a handler (src/proxy.ts answers 303
 * /vin/sent?demo=1). The query `vin`, `car`, `need` pre-fills the form.
 */
export default async function VinPage({ searchParams }: { searchParams: SearchParams }) {
  const brand = getBrand();
  const gate = await currentCheckoutGate();
  const demo = isDemoMode();
  const query = await searchParams;
  const initial = vinFormInitial(query);

  if (!gate.open) {
    const telegram = telegramWithText(brand.pickupLinks?.telegram ?? null);
    return (
      <InnerPage>
        <VinBand initial={initial} />
        <PageBody className="space-y-12 md:space-y-16">
          <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_26rem] lg:gap-8">
            <InfoCard
              title="Позвоните мастеру"
              titleId="vin-call"
              icon={<IconPhone size={40} />}
              aria-labelledby="vin-call"
            >
              <div className="space-y-5">
                <AskedFor initial={initial} />
                <PhoneNumber phone={brand.contactPhone} />
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap">
                  {brand.contactPhone ? (
                    <a
                      className={buttonClass({ variant: 'primary', size: 'lg' })}
                      href={telHref(brand.contactPhone)}
                    >
                      <IconPhone size={20} />
                      Позвонить
                    </a>
                  ) : null}
                  {telegram ? (
                    <a
                      className={buttonClass({ variant: 'secondary', size: 'lg' })}
                      href={telegram}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="vin-telegram"
                    >
                      <IconMessage size={20} className="text-brand" />
                      Фото СТС в Telegram
                    </a>
                  ) : null}
                </div>
                <PickupLines brand={brand} />
              </div>
            </InfoCard>
            <VinPlate />
          </div>
          <section aria-labelledby="vin-how" className="min-w-0">
            <SectionHeading id="vin-how">Как это работает</SectionHeading>
            <VinSteps steps={CALL_STEPS} />
          </section>
          <Guarantee />
        </PageBody>
      </InnerPage>
    );
  }

  const { fields, form } = errorsOf(parseErrorCodes(query.e));
  const env = serverEnv();
  return (
    <InnerPage>
      <VinBand initial={initial} />
      <PageBody className="space-y-12 md:space-y-16">
        <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_26rem] lg:gap-10">
          <div className="min-w-0 space-y-4">
            {/* The demo is marked by the DemoDataBanner strip and the line under the submit
                button: no third note here. */}
            <h2 className="sr-only">Заявка на подбор</h2>
            <VinForm
              consentPdVersionId={gate.docs.consentPd.id}
              requestKey={uuidV7()}
              photos={{
                enabled: demo || photosEnabled(),
                max: VIN_PHOTOS_MAX,
                maxFileMb: env.FILES_MAX_UPLOAD_MB,
              }}
              telegram={demo || Boolean(env.TG_CLIENT_BOT_USERNAME)}
              errors={fields}
              formError={form}
              demo={demo}
              initial={initial}
              vinHelp={<VinWhereFold className="lg:hidden" />}
              invalidMessages={{
                vin: VIN_FORM_MESSAGES.vin,
                car: VIN_FORM_MESSAGES.car,
                need: VIN_FORM_MESSAGES.need,
                phone: VIN_FORM_MESSAGES.phone,
                channel: VIN_FORM_MESSAGES.channel,
                consent: VIN_FORM_MESSAGES.consent,
              }}
            />
          </div>
          <aside className="min-w-0 space-y-4" aria-label="Подсказки к заявке">
            {/* Phones get the same help folded under the VIN field instead. */}
            <VinPlate className="max-lg:hidden" />
            <CallCard brand={brand} />
            <Guarantee />
          </aside>
        </div>
        <section aria-labelledby="vin-how" className="min-w-0">
          <SectionHeading id="vin-how">Как это работает</SectionHeading>
          <VinSteps steps={FORM_STEPS} />
        </section>
      </PageBody>
    </InnerPage>
  );
}
