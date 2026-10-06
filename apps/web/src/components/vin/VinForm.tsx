'use client';

/**
 * The VIN request form (docs/phase-1c-implementation.md decision С12; look: docs/design-v2.md,
 * /vin): a large VIN field with the O/0 and I/1 hint, the car, what is needed, up to three
 * photos, the phone, the answer channel as radio cards (Telegram or SMS; MAX shown as «скоро»),
 * a separate PD consent with the link to its text, and the honeypot.
 *
 * `initial` pre-fills VIN, car and need from the page query (links from the home page and the
 * header search: /vin?vin=…&car=…&need=…). Only default values: the form validates as before.
 *
 * Without JavaScript it is a plain multipart post to /api/vin: errors come back as `?e=<codes>`
 * (the page passes them in as `errors`). With JavaScript the same form is sent by fetch with
 * `Accept: application/json`, so what was typed and the chosen photos stay on screen when a field
 * needs fixing. DEMO_MODE: with JavaScript nothing is sent at all; without it the post goes to
 * the proxy, which answers 303 /vin/sent?demo=1 without reading it.
 */
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { PhotoInput } from '@/components/forms/PhotoInput';
import {
  IconAlert,
  IconArrowRight,
  IconCheck,
  IconMax,
  IconMessage,
  IconTelegram,
  type IconComponent,
} from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { SheetTitle } from '@/components/page/SheetTitle';
import { Spinner, buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { inputClass } from '@/components/ui/Input';
import type { VinFormField } from '@/server/vin/form';

/** Values from the page query, shown as the fields' defaults. */
export interface VinFormInitial {
  vin?: string;
  car?: string;
  need?: string;
}

export interface VinFormProps {
  /** document_versions.id of the consent text linked from the checkbox. */
  consentPdVersionId: string;
  /** uuid v7 rendered by the server: one request per form, whatever the number of submits. */
  requestKey: string;
  photos: { enabled: boolean; max: number; maxFileMb: number };
  /** The client Telegram bot is configured (TG_CLIENT_BOT_USERNAME). */
  telegram: boolean;
  /** Field errors of a post without JavaScript (`?e=`). */
  errors: Partial<Record<VinFormField, string>>;
  formError: string | null;
  demo: boolean;
  initial?: VinFormInitial;
}

const LABEL = 'mb-2 block text-[0.9375rem] leading-snug font-semibold text-ink';
const OPTIONAL = 'font-medium text-muted';
const HINT = 'mt-2 text-small font-normal text-muted';
const DOC_LINK =
  'font-semibold text-brand underline decoration-1 underline-offset-4 hover:text-brand-hover hover:decoration-2';
const TEXTAREA = cn(
  'block min-h-32 w-full min-w-0 resize-y rounded-control border-[1.5px] border-line-strong bg-surface px-4 py-3 text-[1.0625rem] leading-relaxed text-ink',
  'transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-faint hover:border-muted',
  'focus:border-brand focus:bg-bg focus:shadow-[0_0_0_3px_var(--color-brand-soft)] focus-visible:outline-none',
  'aria-invalid:border-danger',
);
const GENERIC_ERROR = 'Не удалось отправить заявку — попробуйте ещё раз';

interface ApiBody {
  error?: string;
  message?: string;
  location?: string;
  fields?: Partial<Record<VinFormField, string>>;
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p
      id={id}
      className="mt-2 flex items-start gap-1.5 text-small font-medium text-danger"
      role="alert"
    >
      <IconAlert size={18} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{message}</span>
    </p>
  );
}

/** One step of the form: a white card with a numbered title. */
function Step({ index, title, children }: { index: string; title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-5 rounded-tile border border-line bg-bg p-5 md:p-6">
      <SheetTitle index={index} as="h3" className="mb-0">
        {title}
      </SheetTitle>
      {children}
    </section>
  );
}

const CHANNELS: readonly {
  value: 'telegram' | 'sms' | 'max';
  label: string;
  Icon: IconComponent;
}[] = [
  { value: 'telegram', label: 'Telegram', Icon: IconTelegram },
  { value: 'sms', label: 'SMS', Icon: IconMessage },
  { value: 'max', label: 'MAX', Icon: IconMax },
];

export function VinForm(props: VinFormProps) {
  const router = useRouter();
  const [fieldErrors, setFieldErrors] = useState(props.errors);
  const [formError, setFormError] = useState(props.formError);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const initial = props.initial ?? {};

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // DEMO_MODE: nothing leaves the browser, the visitor sees the sample answer page (without
    // JavaScript the post goes to the proxy, which answers the same without reading it).
    if (props.demo) {
      setDone(true);
      router.push('/vin/sent?demo=1');
      return;
    }
    if (pending || done) return;
    setPending(true);
    setFormError(null);
    try {
      const response = await fetch('/api/vin', {
        method: 'POST',
        body: new FormData(event.currentTarget),
        headers: { Accept: 'application/json' },
      });
      if (response.redirected) {
        setDone(true);
        window.location.assign(response.url);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as ApiBody;
      if (response.ok && typeof body.location === 'string') {
        setDone(true);
        window.location.assign(body.location);
        return;
      }
      setFieldErrors(body.fields ?? {});
      const fieldCount = Object.keys(body.fields ?? {}).length;
      setFormError(
        fieldCount > 0 && response.status === 422
          ? 'Проверьте отмеченные поля'
          : (body.message ?? GENERIC_ERROR),
      );
    } catch {
      setFormError(GENERIC_ERROR);
    } finally {
      setPending(false);
    }
  }

  const err = fieldErrors;
  const invalid = (field: VinFormField) => (err[field] ? true : undefined);

  return (
    <form
      id="vin-form"
      method="post"
      action="/api/vin"
      encType="multipart/form-data"
      onSubmit={(event) => void onSubmit(event)}
      className="relative min-w-0 space-y-4"
      data-testid="vin-form"
    >
      {formError ? (
        <Notice tone="danger" role="alert" data-testid="vin-form-error">
          {formError}
        </Notice>
      ) : null}

      <Step index="01" title="Автомобиль">
        <div className="min-w-0">
          <label htmlFor="vin-vin" className={LABEL}>
            VIN
          </label>
          <input
            id="vin-vin"
            name="vin"
            type="text"
            required
            minLength={17}
            maxLength={24}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="17 символов из СТС"
            defaultValue={initial.vin}
            aria-invalid={invalid('vin')}
            aria-describedby="vin-vin-hint vin-vin-error"
            className={inputClass({
              size: 'lg',
              mono: true,
              className:
                'font-bold tracking-[0.08em] uppercase placeholder:font-medium placeholder:tracking-normal placeholder:normal-case',
            })}
          />
          <p id="vin-vin-hint" className={HINT}>
            Букв O, I и Q в VIN не бывает — вместо них цифры 0 и 1.
          </p>
          <FieldError id="vin-vin-error" message={err.vin} />
        </div>
        <div className="min-w-0">
          <label htmlFor="vin-car" className={LABEL}>
            Марка и модель <span className={OPTIONAL}>(необязательно)</span>
          </label>
          <input
            id="vin-car"
            name="car"
            type="text"
            maxLength={200}
            autoComplete="off"
            placeholder="Например, Lada Granta 2019"
            defaultValue={initial.car}
            aria-invalid={invalid('car')}
            aria-describedby="vin-car-error"
            className={inputClass()}
          />
          <FieldError id="vin-car-error" message={err.car} />
        </div>
      </Step>

      <Step index="02" title="Что нужно">
        <div className="min-w-0">
          <label htmlFor="vin-need" className={LABEL}>
            Какая деталь нужна
          </label>
          <textarea
            id="vin-need"
            name="need"
            required
            minLength={3}
            maxLength={1000}
            rows={3}
            placeholder="Например: передние колодки и диски"
            defaultValue={initial.need}
            aria-invalid={invalid('need')}
            aria-describedby="vin-need-hint vin-need-error"
            className={TEXTAREA}
          />
          <p id="vin-need-hint" className={HINT}>
            Своими словами. Телефон сюда писать не нужно.
          </p>
          <FieldError id="vin-need-error" message={err.need} />
        </div>
        {props.photos.enabled ? (
          <PhotoInput
            label="Фото (необязательно)"
            hint={`До ${props.photos.max} фото: табличка с VIN, СТС или старая деталь. Каждое до ${props.photos.maxFileMb} МБ.`}
            max={props.photos.max}
            maxFileMb={props.photos.maxFileMb}
            error={err.photos}
            disabled={pending}
          />
        ) : null}
      </Step>

      <Step index="03" title="Куда прислать подборку">
        <div className="min-w-0">
          <label htmlFor="vin-phone" className={LABEL}>
            Телефон
          </label>
          <input
            id="vin-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            maxLength={24}
            placeholder="+7 900 000-00-00"
            aria-invalid={invalid('phone')}
            aria-describedby="vin-phone-hint vin-phone-error"
            className={inputClass({ className: 'tabular-nums' })}
          />
          <p id="vin-phone-hint" className={HINT}>
            Мобильный. Мастер может позвонить, чтобы уточнить.
          </p>
          <FieldError id="vin-phone-error" message={err.phone} />
        </div>
        <fieldset className="min-w-0" aria-describedby="vin-channel-hint vin-channel-error">
          <legend className={LABEL}>Как прислать ссылку</legend>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {CHANNELS.map((channel) => {
              const disabled =
                channel.value === 'max' || (channel.value === 'telegram' && !props.telegram);
              return (
                <label
                  key={channel.value}
                  className={cn(
                    'relative flex min-h-24 min-w-0 flex-col items-center justify-center gap-1.5 rounded-control border-[1.5px] px-2 py-3 text-center font-semibold transition-colors',
                    disabled
                      ? 'cursor-not-allowed border-line bg-surface text-muted'
                      : 'cursor-pointer border-line-strong bg-bg text-ink hover:border-muted has-[:checked]:border-brand has-[:checked]:bg-brand-soft',
                    'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand',
                  )}
                >
                  <input
                    type="radio"
                    name="channel"
                    value={channel.value}
                    disabled={disabled}
                    required
                    defaultChecked={
                      props.telegram ? channel.value === 'telegram' : channel.value === 'sms'
                    }
                    className="peer sr-only"
                  />
                  <channel.Icon
                    size={28}
                    className={disabled ? 'text-faint' : 'text-brand'}
                    strokeWidth={1.75}
                  />
                  <span className="max-w-full text-base leading-tight wrap-anywhere">
                    {channel.label}
                  </span>
                  {disabled ? (
                    <span className="text-caption font-medium text-muted">скоро</span>
                  ) : null}
                  <span
                    aria-hidden
                    className="absolute top-2 right-2 hidden size-6 place-items-center rounded-full bg-brand text-on-brand peer-checked:grid"
                  >
                    <IconCheck size={16} strokeWidth={2.5} />
                  </span>
                </label>
              );
            })}
          </div>
          <p id="vin-channel-hint" className={HINT}>
            {props.telegram
              ? 'В Telegram подключите бота после отправки. Или пришлём SMS.'
              : 'Пришлём ссылку на подборку в SMS.'}
          </p>
          <FieldError id="vin-channel-error" message={err.channel} />
        </fieldset>
      </Step>

      <section className="min-w-0 rounded-tile border border-line bg-bg p-5 md:p-6">
        <label className="flex cursor-pointer items-start gap-3 text-body">
          <span className="relative grid size-7 shrink-0 place-items-center">
            <input
              type="checkbox"
              name="consentPd"
              onChange={(event) => setConsent(event.target.checked)}
              required
              aria-invalid={invalid('consent')}
              aria-describedby="vin-consent-error"
              className="peer size-6 cursor-pointer appearance-none rounded-md border-2 border-line-strong bg-bg transition-colors hover:border-muted checked:border-brand checked:bg-brand aria-invalid:border-danger"
            />
            <IconCheck
              size={18}
              strokeWidth={2.5}
              className="pointer-events-none absolute hidden text-on-brand peer-checked:block"
            />
          </span>
          <span className="min-w-0">
            Даю{' '}
            <a className={DOC_LINK} href="/docs/consent" target="_blank" rel="noopener">
              согласие на обработку персональных данных
            </a>{' '}
            и фото для подбора
          </span>
        </label>
        <FieldError id="vin-consent-error" message={err.consent} />
      </section>

      {/* Honeypot: off screen, skipped by keyboard and screen readers; people never fill it. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="vin-website">Сайт</label>
        <input id="vin-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <input type="hidden" name="consentPdVersionId" value={props.consentPdVersionId} />
      <input type="hidden" name="requestKey" value={props.requestKey} />

      <div className="min-w-0 space-y-3 pt-2">
        <button
          type="submit"
          disabled={pending || done}
          aria-busy={pending || undefined}
          className={cn(buttonClass({ variant: 'primary', size: 'lg', block: true }), 'md:w-auto')}
          data-testid="vin-submit"
        >
          {pending ? <Spinner /> : null}
          {done ? 'Открываем…' : pending ? 'Отправляем…' : 'Отправить заявку'}
          {!done && !pending ? <IconArrowRight size={20} /> : null}
        </button>
        <p className="min-w-0 text-small font-normal text-muted">
          {props.demo
            ? 'Демо: заявка не уйдёт — покажем, как выглядит ответ.'
            : consent
              ? 'Бесплатно. Мастер ответит в рабочее время, обычно за 4 часа.'
              : 'Чтобы отправить, отметьте согласие.'}
        </p>
      </div>
    </form>
  );
}
