'use client';

/**
 * The VIN request form (docs/phase-1c-implementation.md decision С12) in «Техкарта»: VIN with the
 * O/0 and I/1 hint, the car, what is needed, up to three photos, the phone, the answer channel
 * (Telegram or SMS; MAX shown as «скоро»), a separate PD consent with the link to its text, and
 * the honeypot.
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
import { IconAlert, IconArrowRight, IconCheck } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { SheetTitle } from '@/components/page/SheetTitle';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { inputClass } from '@/components/ui/Input';
import type { VinFormField } from '@/server/vin/form';

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
}

const LABEL = 'mb-1.5 block text-sm font-medium text-ink';
const DOC_LINK =
  'font-medium text-accent-ink underline decoration-1 underline-offset-4 hover:decoration-2';
const TEXTAREA = cn(
  'block min-h-32 w-full min-w-0 resize-y rounded border-[1.5px] border-line-strong bg-card px-4 py-3 text-base text-ink',
  'transition-[border-color,box-shadow] duration-150 placeholder:text-faint hover:border-muted',
  'focus:border-ink focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_35%,transparent)] focus-visible:outline-none',
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
    <p id={id} className="mt-1.5 flex items-start gap-1.5 text-sm text-danger" role="alert">
      <IconAlert size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{message}</span>
    </p>
  );
}

function Sheet({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn('min-w-0 rounded border border-line bg-card p-5 md:p-6', className)}>
      {children}
    </section>
  );
}

const CHANNELS = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'sms', label: 'SMS' },
  { value: 'max', label: 'MAX' },
] as const;

export function VinForm(props: VinFormProps) {
  const router = useRouter();
  const [fieldErrors, setFieldErrors] = useState(props.errors);
  const [formError, setFormError] = useState(props.formError);
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

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
      className="relative min-w-0 space-y-5"
      data-testid="vin-form"
    >
      {formError ? (
        <Notice tone="danger" role="alert" data-testid="vin-form-error">
          {formError}
        </Notice>
      ) : null}

      <Sheet className="space-y-5">
        <SheetTitle index="01">Автомобиль</SheetTitle>
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
            placeholder="XTA210990Y1234567"
            aria-invalid={invalid('vin')}
            aria-describedby="vin-vin-hint vin-vin-error"
            className={inputClass({ mono: true, className: 'uppercase' })}
          />
          <p id="vin-vin-hint" className="mt-1.5 text-sm text-muted">
            17 знаков из СТС или с таблички под лобовым стеклом. Букв O, I и Q в VIN не бывает —
            вместо них пишите цифры 0 и 1.
          </p>
          <FieldError id="vin-vin-error" message={err.vin} />
        </div>
        <div className="min-w-0">
          <label htmlFor="vin-car" className={LABEL}>
            Марка и модель <span className="font-normal text-muted">(необязательно)</span>
          </label>
          <input
            id="vin-car"
            name="car"
            type="text"
            maxLength={200}
            autoComplete="off"
            placeholder="Например, Lada Granta 2019, 1.6"
            aria-invalid={invalid('car')}
            aria-describedby="vin-car-error"
            className={inputClass()}
          />
          <FieldError id="vin-car-error" message={err.car} />
        </div>
      </Sheet>

      <Sheet className="space-y-5">
        <SheetTitle index="02">Что нужно</SheetTitle>
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
            rows={4}
            placeholder="Например: передние тормозные колодки и диски, масляный фильтр"
            aria-invalid={invalid('need')}
            aria-describedby="vin-need-hint vin-need-error"
            className={TEXTAREA}
          />
          <p id="vin-need-hint" className="mt-1.5 text-sm text-muted">
            Можно своими словами. Телефон и данные документов сюда писать не нужно.
          </p>
          <FieldError id="vin-need-error" message={err.need} />
        </div>
        {props.photos.enabled ? (
          <PhotoInput
            label="Фото (необязательно)"
            hint={`До ${props.photos.max} фото: табличка с VIN, СТС или старая деталь. Каждое до ${props.photos.maxFileMb} МБ — уменьшим перед отправкой.`}
            max={props.photos.max}
            maxFileMb={props.photos.maxFileMb}
            error={err.photos}
            disabled={pending}
          />
        ) : null}
      </Sheet>

      <Sheet className="space-y-5">
        <SheetTitle index="03">Куда прислать подборку</SheetTitle>
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
          <p id="vin-phone-hint" className="mt-1.5 text-sm text-muted">
            Мобильный номер: +7 или 8 и 10 цифр. Мастер может позвонить, чтобы уточнить деталь.
          </p>
          <FieldError id="vin-phone-error" message={err.phone} />
        </div>
        <fieldset className="min-w-0" aria-describedby="vin-channel-hint vin-channel-error">
          <legend className={LABEL}>Как прислать ссылку на подборку</legend>
          <div className="flex flex-wrap gap-2 sm:grid sm:grid-cols-3">
            {CHANNELS.map((channel) => {
              const disabled =
                channel.value === 'max' || (channel.value === 'telegram' && !props.telegram);
              return (
                <label
                  key={channel.value}
                  className={cn(
                    'flex h-12 min-w-0 grow items-center gap-2 rounded border-[1.5px] border-line bg-card px-3 font-medium transition-colors sm:gap-2.5 sm:px-4',
                    disabled
                      ? 'cursor-not-allowed bg-paper-2 text-faint'
                      : 'cursor-pointer hover:border-muted has-[:checked]:border-ink has-[:checked]:bg-paper',
                    'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
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
                    className="size-4.5 shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-line-strong bg-card transition-[border-width,border-color] checked:border-[5px] checked:border-ink focus-visible:outline-none disabled:cursor-not-allowed"
                  />
                  <span className="whitespace-nowrap">{channel.label}</span>
                  {disabled ? <span className="ml-auto text-xs font-normal">скоро</span> : null}
                </label>
              );
            })}
          </div>
          <p id="vin-channel-hint" className="mt-3 text-sm text-muted">
            {props.telegram
              ? 'Telegram: после отправки подключите бота одной кнопкой. SMS: пришлём ссылку сообщением.'
              : 'Пришлём ссылку на подборку в SMS.'}
          </p>
          <FieldError id="vin-channel-error" message={err.channel} />
        </fieldset>
      </Sheet>

      <Sheet className="space-y-3">
        <SheetTitle index="04">Согласие</SheetTitle>
        <label className="flex cursor-pointer items-start gap-3 leading-snug">
          <span className="relative grid size-[22px] shrink-0 place-items-center">
            <input
              type="checkbox"
              name="consentPd"
              onChange={(event) => setConsent(event.target.checked)}
              required
              aria-invalid={invalid('consent')}
              aria-describedby="vin-consent-error"
              className="peer size-[22px] cursor-pointer appearance-none rounded-sm border-[1.5px] border-line-strong bg-card transition-colors hover:border-muted checked:border-ink checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <IconCheck
              size={16}
              strokeWidth={2.5}
              className="pointer-events-none absolute hidden text-ink peer-checked:block"
            />
          </span>
          <span className="min-w-0 pt-px">
            Даю{' '}
            <a className={DOC_LINK} href="/docs/consent" target="_blank" rel="noopener">
              согласие на обработку персональных данных
            </a>
            , включая фото, для подбора детали
          </span>
        </label>
        <FieldError id="vin-consent-error" message={err.consent} />
      </Sheet>

      {/* Honeypot: off screen, skipped by keyboard and screen readers; people never fill it. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="vin-website">Сайт</label>
        <input id="vin-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <input type="hidden" name="consentPdVersionId" value={props.consentPdVersionId} />
      <input type="hidden" name="requestKey" value={props.requestKey} />

      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
        <button
          type="submit"
          disabled={pending || done}
          className={cn(
            buttonClass({ variant: 'primary', size: 'lg' }),
            'w-full shrink-0 sm:w-auto',
          )}
          data-testid="vin-submit"
        >
          {done ? 'Открываем…' : pending ? 'Отправляем…' : 'Отправить заявку'}
          {!done && !pending ? <IconArrowRight size={18} /> : null}
        </button>
        <p className="min-w-0 text-sm text-muted">
          {props.demo
            ? 'Демо: заявка не отправляется — покажем, как выглядит ответ.'
            : consent
              ? 'Подбор бесплатный. Мастер ответит в рабочее время, обычно в течение 4 часов.'
              : 'Чтобы отправить заявку, отметьте согласие на обработку данных.'}
        </p>
      </div>
    </form>
  );
}
