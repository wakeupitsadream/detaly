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
import { InfoCard } from '@/components/ui/Card';
import { SectionHeading } from '@/components/ui/Section';
import { VinForm, type VinFormInitial } from '@/components/vin/VinForm';
import { VinPlate, VinSteps, VinWhereFold, type VinStep } from '@/components/vin/VinPlate';
import { vinFormInitial } from '@/components/vin/vin-query';
import { getBrand, telHref, type Brand } from '@/server/brand';
import { currentCheckoutGate } from '@/server/checkout-gate';
import { uuidV7 } from '@/server/checkout/uuid';
import { serverEnv } from '@/server/env';
import { photosEnabled } from '@/server/files';
import { isDemoMode } from '@/server/mode';
import { errorsOf, parseErrorCodes } from '@/server/vin/form';

export const metadata: Metadata = { title: 'Подбор запчастей по VIN' };

// The form appears with the checkout gate (RKN number, documents, pickup point): runtime env
// and the database decide, so the page is rendered per request.
export const dynamic = 'force-dynamic';

const TITLE = 'Подбор по VIN';
const LEAD = 'Мастер подберёт деталь и пришлёт цены. Бесплатно.';

/**
 * The lead line: with a make or a category from the home tiles (?car=, ?need=) it names the
 * choice — «Марка: Kia · Нужно: Фильтры …» — and what is left to do, so the tap never looks
 * lost on a VIN form.
 */
function leadOf(initial: VinFormInitial): string {
  const chosen = [
    initial.car ? `Марка: ${initial.car}` : null,
    initial.need ? `Нужно: ${initial.need}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return chosen ? `${chosen}. Впишите VIN — мастер подберёт деталь бесплатно.` : LEAD;
}

/** Steps while there is no online form (phase 0 and a closed gate). */
const CALL_STEPS: readonly VinStep[] = [
  { icon: <IconSts size={36} strokeWidth={1.5} />, title: 'Найдите VIN', text: 'Он есть в СТС.' },
  {
    icon: <IconPhone size={36} strokeWidth={1.5} />,
    title: 'Позвоните',
    text: 'Назовите VIN и нужную деталь.',
  },
  {
    icon: <IconWrench size={36} strokeWidth={1.5} />,
    title: 'Получите варианты',
    text: 'С ценой и датой получения.',
  },
];

/** Steps next to the form (phase 1C). */
const FORM_STEPS: readonly VinStep[] = [
  {
    icon: <IconSts size={36} strokeWidth={1.5} />,
    title: 'Заявка',
    text: 'VIN и что нужно.',
  },
  {
    icon: <IconWrench size={36} strokeWidth={1.5} />,
    title: 'Мастер подберёт',
    text: 'Пришлёт ссылку с ценами и датами.',
  },
  {
    icon: <IconCart size={36} strokeWidth={1.5} />,
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

/** The VIN guarantee as one row: the shield and one sentence. */
function Guarantee() {
  return (
    <div className="flex min-w-0 items-start gap-4 rounded-tile border border-line p-5 md:p-6">
      <IconShield size={40} strokeWidth={1.5} className="shrink-0 text-brand" />
      <div className="min-w-0">
        <h2 className="text-h3">Подобрали мы&nbsp;— отвечаем мы</h2>
        <p className="mt-1 text-small font-normal text-muted">
          Не подошла к машине из заявки — вернём деньги.
        </p>
      </div>
    </div>
  );
}

/** «Удобнее позвонить?» next to the form; without a phone there is no such card. */
function CallCard({ brand }: { brand: Brand }) {
  if (!brand.contactPhone) return null;
  return (
    <section
      aria-labelledby="vin-call"
      className="min-w-0 space-y-4 rounded-tile border border-line p-5 md:p-6"
    >
      <h2 id="vin-call" className="text-h3">
        Удобнее позвонить?
      </h2>
      <PhoneNumber phone={brand.contactPhone} />
      <PickupLines brand={brand} />
    </section>
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
        <PageBand tone="light" title={TITLE} lead={leadOf(initial)} />
        <PageBody className="space-y-12 md:space-y-16">
          <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_26rem] lg:gap-8">
            <InfoCard
              title="Позвоните мастеру"
              titleId="vin-call"
              icon={<IconPhone size={40} strokeWidth={1.5} />}
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
      <PageBand tone="light" title={TITLE} lead={leadOf(initial)} />
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
