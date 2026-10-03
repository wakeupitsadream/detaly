import { VIN_PHOTOS_MAX } from '@detaly/domain';
import type { Metadata } from 'next';
import { IconClock, IconMessage, IconPhone, IconPin, IconShield } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { VinForm } from '@/components/vin/VinForm';
import { VinPlate, VinSteps } from '@/components/vin/VinPlate';
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

/** Steps while there is no online form (phase 0 and a closed gate). */
const CALL_STEPS = [
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

/** Steps next to the form (phase 1C). */
const FORM_STEPS = [
  {
    title: 'Заполните заявку',
    text: 'VIN, что нужно и, если удобно, фото таблички, СТС или старой детали.',
  },
  {
    title: 'Мастер подберёт',
    text: 'Проверит детали у поставщика и пришлёт ссылку на подборку с ценами и датами.',
  },
  {
    title: 'Оформите по ссылке',
    text: 'Как обычный заказ: оплата онлайн или при получении, если всё есть в Оренбурге.',
  },
] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The chat link with a ready first line, so the client only adds the photo. */
function telegramWithText(url: string | null): string | null {
  if (!url) return null;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}text=${encodeURIComponent('Нужна деталь по VIN: ')}`;
}

/** The phone panel and the guarantee: next to the form, or instead of it. */
function ContactAside({ brand, withForm }: { brand: Brand; withForm: boolean }) {
  const { pickup } = brand;
  const telegram = withForm ? null : telegramWithText(brand.pickupLinks?.telegram ?? null);
  return (
    <aside
      className={cn('min-w-0 space-y-5', !withForm && 'max-lg:order-first')}
      aria-label="Контакты для запроса"
    >
      <section className="grain-dark min-w-0 rounded border border-graphite-700 bg-graphite-900 bg-blueprint p-5 text-steel-200 md:p-6">
        <h2 className="text-label text-steel-400">{withForm ? 'Удобнее позвонить?' : 'Телефон'}</h2>
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
              buttonClass({
                variant: withForm ? 'secondary' : 'primary',
                onDark: true,
                block: true,
              }),
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
            className={cn(buttonClass({ variant: 'secondary', onDark: true, block: true }), 'mt-3')}
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
              Если деталь, подобранная мастером по VIN, не подошла к автомобилю из заявки, вернём
              деньги полностью.
            </p>
          </div>
        </div>
      </section>
    </aside>
  );
}

/**
 * /vin. With the checkout gate open (RKN number, published documents, pickup point; decision
 * С12) — the request form; otherwise the phase 0 page without a form (PLAN decision 14: no PD
 * form before the RKN notice), the phone and the chat of the point. DEMO_MODE shows the form;
 * its post never reaches a handler (src/proxy.ts answers 303 /vin/sent?demo=1).
 */
export default async function VinPage({ searchParams }: { searchParams: SearchParams }) {
  const brand = getBrand();
  const gate = await currentCheckoutGate();
  const demo = isDemoMode();
  const lead =
    'Мастер подберёт деталь под ваш автомобиль по VIN. Если подобрали мы и деталь не подошла к автомобилю из заявки — вернём деньги полностью.';

  if (!gate.open) {
    return (
      <InnerPage>
        <PageBand
          eyebrow="Не знаете артикул"
          title="Подбор запчастей по VIN — бесплатно"
          lead={lead}
        />
        <PageBody>
          <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-16">
            <div className="min-w-0 space-y-10">
              <section aria-labelledby="vin-how" className="min-w-0">
                <h2 id="vin-how" className="text-h2">
                  Как прислать запрос
                </h2>
                <VinSteps steps={CALL_STEPS} />
              </section>
              <VinPlate />
            </div>
            {/* Phones: the call comes right under the title, before the steps. */}
            <ContactAside brand={brand} withForm={false} />
          </div>
        </PageBody>
      </InnerPage>
    );
  }

  const { fields, form } = errorsOf(parseErrorCodes((await searchParams).e));
  const env = serverEnv();
  return (
    <InnerPage>
      <PageBand
        eyebrow="Не знаете артикул"
        title="Подбор запчастей по VIN — бесплатно"
        lead={lead}
      />
      <PageBody>
        <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-16">
          <div className="min-w-0 space-y-10">
            {demo ? (
              <Notice tone="info" title="Демо: заявка не отправляется" data-testid="vin-demo">
                Форма работает как на настоящем сайте, но данные никуда не уходят — после отправки
                покажем, как выглядит ответ.
              </Notice>
            ) : null}
            <section aria-labelledby="vin-form-title" className="min-w-0">
              <h2 id="vin-form-title" className="mb-6 text-h2">
                Заявка на подбор
              </h2>
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
              />
            </section>
            <section aria-labelledby="vin-how" className="min-w-0">
              <h2 id="vin-how" className="text-h2">
                Как это работает
              </h2>
              <VinSteps steps={FORM_STEPS} />
            </section>
            <VinPlate />
          </div>
          <ContactAside brand={brand} withForm />
        </div>
      </PageBody>
    </InnerPage>
  );
}
