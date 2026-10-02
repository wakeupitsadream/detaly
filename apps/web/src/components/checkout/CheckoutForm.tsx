'use client';

import type { LineChange, PaymentScheme } from '@detaly/domain';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { DiffBanner } from '@/components/DiffBanner';
import { IconAlert, IconArrowRight, IconCheck } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { SheetTitle } from '@/components/page/SheetTitle';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { inputClass } from '@/components/ui/Input';
import { PAYMENT_SCHEME_TITLE } from './scheme-text';

type Field = 'phone' | 'name' | 'channel' | 'acceptOffer' | 'consentPd';

export interface CheckoutFormProps {
  part: 'all' | 'local' | 'order';
  expectedTotalKop: number;
  itemsHash: string;
  /** uuid v7 rendered by the server: one order per form, whatever the number of submits. */
  checkoutKey: string;
  /** Versions of the linked documents, sent back so the order records exactly these. */
  documents: {
    offerVersionId: string;
    consentPdVersionId: string;
    consentMarketingVersionId: string | null;
  };
  /** Payment scheme shown on the page (no-shows counted as 0). */
  expectedScheme: PaymentScheme;
  /** Promised date shown on the page (ISO), null without one. */
  expectedPromisedDate: string | null;
  marketingAvailable: boolean;
  /** Order minimum not reached: the message, and the submit button stays disabled. */
  blockedMessage: string | null;
  contactPhone: string | null;
}

const CHANNELS = [
  { value: 'max', label: 'MAX' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'sms', label: 'SMS' },
] as const;

const GENERIC_ERROR = 'Не удалось оформить заказ — попробуйте ещё раз';

interface ApiBody {
  error?: string;
  message?: string;
  orderUrl?: string;
  fields?: Partial<Record<Field, string>>;
  changes?: LineChange[];
  totalKop?: number | null;
  itemsHash?: string | null;
  promisedDate?: string;
  promiseText?: string;
  scheme?: PaymentScheme;
  explanation?: string[];
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

const LABEL = 'mb-1.5 block text-sm font-medium text-ink';
const DOC_LINK =
  'font-medium text-accent-ink underline decoration-1 underline-offset-4 hover:decoration-2';

/** A sheet of the form: card on paper, 1px line, no shadow. */
function Sheet({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn('min-w-0 rounded border border-line bg-card p-5 md:p-6', className)}>
      {children}
    </section>
  );
}

/**
 * A consent checkbox: a 22px square, signal-orange fill with an ink tick when checked. The
 * native input stays in place (keyboard, form data, the label as its name), only its look
 * changes.
 */
function Consent({
  name,
  checked,
  onChange,
  describedBy,
  children,
}: {
  name: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  describedBy?: string;
  children: ReactNode;
}) {
  const controlled = onChange
    ? {
        checked: checked ?? false,
        onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked),
      }
    : {};
  return (
    <label className="flex cursor-pointer items-start gap-3 leading-snug">
      <span className="relative grid size-[22px] shrink-0 place-items-center">
        <input
          type="checkbox"
          name={name}
          className="peer size-[22px] cursor-pointer appearance-none rounded-sm border-[1.5px] border-line-strong bg-card transition-colors hover:border-muted checked:border-ink checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-describedby={describedBy}
          {...controlled}
        />
        <IconCheck
          size={16}
          strokeWidth={2.5}
          className="pointer-events-none absolute hidden text-ink peer-checked:block"
        />
      </span>
      <span className="min-w-0 pt-px">{children}</span>
    </label>
  );
}

/**
 * One-screen checkout form (docs/phase-1a-implementation.md section 6.1). Sends JSON to
 * POST /api/checkout; 201 opens the order page, 409 shows what changed and refreshes the
 * summary, 422 marks the fields. Prices and totals are never taken from this form: the server
 * only compares the expected total and items hash with its own fresh repricing.
 */
export function CheckoutForm(props: CheckoutFormProps) {
  const router = useRouter();
  const [acceptOffer, setAcceptOffer] = useState(false);
  const [consentPd, setConsentPd] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [changes, setChanges] = useState<LineChange[] | null>(null);
  // Values from a 409 answer until the refreshed page brings its own.
  const [override, setOverride] = useState<{ totalKop: number; itemsHash: string } | null>(null);
  const [promise, setPromise] = useState<{ date: string; text: string } | null>(null);
  // 409 scheme_changed: the scheme for this phone, shown here and sent back on resubmit.
  const [schemeNotice, setSchemeNotice] = useState<{
    scheme: PaymentScheme;
    explanation: string[];
  } | null>(null);

  useEffect(() => {
    setOverride(null);
  }, [props.expectedTotalKop, props.itemsHash]);
  useEffect(() => {
    setPromise(null);
  }, [props.expectedPromisedDate]);

  // On a phone the submit button is far below the banner: bring a fresh 409 banner into view
  // and move focus there, so the client sees that the order was not created.
  const changesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (changes === null && schemeNotice === null) return;
    const node = changesRef.current;
    node?.scrollIntoView({ block: 'center' });
    node?.focus({ preventScroll: true });
  }, [changes, schemeNotice]);

  const expectedTotalKop = override?.totalKop ?? props.expectedTotalKop;
  const itemsHash = override?.itemsHash ?? props.itemsHash;
  const expectedPromisedDate = promise?.date ?? props.expectedPromisedDate;
  const expectedScheme = schemeNotice?.scheme ?? props.expectedScheme;
  const blocked = props.blockedMessage !== null;
  const canSubmit = acceptOffer && consentPd && !pending && !done && !blocked;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    let response: Response;
    let body: ApiBody;
    try {
      response = await fetch('/api/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          part: props.part,
          phone: String(data.get('phone') ?? ''),
          name: String(data.get('name') ?? ''),
          channel: String(data.get('channel') ?? ''),
          acceptOffer,
          consentPd,
          consentMarketing: data.get('consentMarketing') === 'on',
          expectedTotalKop,
          itemsHash,
          checkoutKey: props.checkoutKey,
          ...props.documents,
          expectedScheme,
          expectedPromisedDate,
          website: String(data.get('website') ?? ''),
        }),
      });
      body = (await response.json().catch(() => ({}))) as ApiBody;
    } catch {
      setPending(false);
      setFormError('Нет связи с сервером — проверьте интернет и попробуйте ещё раз');
      return;
    }

    if ((response.status === 200 || response.status === 201) && body.orderUrl) {
      setDone(true);
      window.location.assign(body.orderUrl);
      return;
    }
    setPending(false);
    if (response.status === 409 && body.error === 'stale') {
      setChanges(body.changes ?? []);
      if (typeof body.totalKop === 'number' && typeof body.itemsHash === 'string') {
        setOverride({ totalKop: body.totalKop, itemsHash: body.itemsHash });
      }
      if (typeof body.promisedDate === 'string' && typeof body.promiseText === 'string') {
        setPromise({ date: body.promisedDate, text: body.promiseText });
      }
      router.refresh();
      return;
    }
    if (response.status === 409 && body.error === 'scheme_changed' && body.scheme) {
      setSchemeNotice({ scheme: body.scheme, explanation: body.explanation ?? [] });
      return;
    }
    if (response.status === 409 && body.error === 'documents_changed') {
      // New texts: the client reads them and ticks the boxes again on the refreshed page.
      setAcceptOffer(false);
      setConsentPd(false);
      setFormError(body.message ?? GENERIC_ERROR);
      router.refresh();
      return;
    }
    if (response.status === 422 && body.fields) {
      setFieldErrors(body.fields);
      setFormError(body.message ?? null);
      return;
    }
    setFormError(body.message ?? GENERIC_ERROR);
  }

  return (
    <form
      className="min-w-0 space-y-6"
      onSubmit={(e) => void onSubmit(e)}
      data-testid="checkout-form"
    >
      {changes !== null || schemeNotice !== null ? (
        <div
          ref={changesRef}
          tabIndex={-1}
          className="space-y-2 outline-none"
          data-testid="checkout-stale"
        >
          {changes !== null && (changes.length > 0 || promise === null) ? (
            <DiffBanner changes={changes} cartChanged />
          ) : null}
          {promise !== null ? (
            <Notice tone="wait" role="status" data-testid="checkout-promise-changed">
              Срок получения изменился: {promise.text}
            </Notice>
          ) : null}
          {schemeNotice !== null ? (
            <Notice
              tone="wait"
              role="status"
              data-testid="checkout-scheme-changed"
              title={`Способ оплаты: ${PAYMENT_SCHEME_TITLE[schemeNotice.scheme]}`}
            >
              {schemeNotice.explanation.map((sentence) => (
                <p key={sentence}>{sentence}</p>
              ))}
            </Notice>
          ) : null}
          <p className="text-sm text-muted">
            {schemeNotice !== null && changes === null
              ? 'Заказ не оформлен. Проверьте способ оплаты и отправьте форму ещё раз.'
              : 'Заказ не оформлен. Мы обновили данные заказа — проверьте их и отправьте форму ещё раз.'}
          </p>
        </div>
      ) : null}

      <Sheet>
        <SheetTitle index="01">Контакты</SheetTitle>
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="checkout-phone" className={LABEL}>
              Телефон
            </label>
            <input
              id="checkout-phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              maxLength={32}
              placeholder="+7 912 345-67-89"
              aria-invalid={fieldErrors.phone ? true : undefined}
              aria-describedby="checkout-phone-hint checkout-phone-error"
              className={inputClass({ className: 'tabular-nums' })}
            />
            <p id="checkout-phone-hint" className="mt-1.5 text-sm text-muted">
              Мобильный номер: +7 или 8 и 10 цифр. По нему вы получите заказ.
            </p>
            <FieldError id="checkout-phone-error" message={fieldErrors.phone} />
          </div>
          <div className="min-w-0">
            <label htmlFor="checkout-name" className={LABEL}>
              Имя
            </label>
            <input
              id="checkout-name"
              name="name"
              type="text"
              autoComplete="name"
              required
              maxLength={60}
              placeholder="Как к вам обращаться"
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby="checkout-name-error"
              className={inputClass()}
            />
            <FieldError id="checkout-name-error" message={fieldErrors.name} />
          </div>
        </div>
      </Sheet>

      <Sheet>
        <fieldset className="min-w-0">
          <legend className="sr-only">Куда присылать статусы заказа</legend>
          <SheetTitle index="02">Куда присылать статусы заказа</SheetTitle>
          <div className="flex flex-wrap gap-2 sm:grid sm:grid-cols-3">
            {CHANNELS.map((channel) => (
              <label
                key={channel.value}
                className={cn(
                  'flex h-12 min-w-0 grow cursor-pointer items-center gap-2 rounded border-[1.5px] border-line bg-card px-3 font-medium transition-colors sm:gap-2.5 sm:px-4',
                  'hover:border-muted has-[:checked]:border-ink has-[:checked]:bg-paper',
                  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                )}
              >
                <input
                  type="radio"
                  name="channel"
                  value={channel.value}
                  required
                  className="size-4.5 shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-line-strong bg-card transition-[border-width,border-color] checked:border-[5px] checked:border-ink focus-visible:outline-none"
                />
                <span className="whitespace-nowrap">{channel.label}</span>
              </label>
            ))}
          </div>
          <p className="mt-3 text-sm text-muted">
            Это предпочтение: подключить уведомления можно будет на странице заказа.
          </p>
          <FieldError id="checkout-channel-error" message={fieldErrors.channel} />
        </fieldset>
      </Sheet>

      <Sheet className="space-y-4">
        <SheetTitle index="03">Согласия</SheetTitle>
        <Consent
          name="acceptOffer"
          checked={acceptOffer}
          onChange={setAcceptOffer}
          describedBy="checkout-offer-error"
        >
          Принимаю условия{' '}
          <a className={DOC_LINK} href="/docs/offer" target="_blank" rel="noopener">
            оферты
          </a>
        </Consent>
        <FieldError id="checkout-offer-error" message={fieldErrors.acceptOffer} />
        <Consent
          name="consentPd"
          checked={consentPd}
          onChange={setConsentPd}
          describedBy="checkout-pd-error"
        >
          Даю{' '}
          <a className={DOC_LINK} href="/docs/consent" target="_blank" rel="noopener">
            согласие на обработку персональных данных
          </a>
        </Consent>
        <FieldError id="checkout-pd-error" message={fieldErrors.consentPd} />
        {props.marketingAvailable ? (
          <Consent name="consentMarketing">
            Хочу получать предложения и скидки (
            <a className={DOC_LINK} href="/docs/consent-marketing" target="_blank" rel="noopener">
              согласие
            </a>
            , необязательно)
          </Consent>
        ) : null}
      </Sheet>

      {/* Honeypot: off screen, skipped by keyboard and screen readers; people never fill it. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="checkout-website">Сайт</label>
        <input id="checkout-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <input type="hidden" name="part" value={props.part} />
      <input type="hidden" name="expectedTotalKop" value={expectedTotalKop} />
      <input type="hidden" name="itemsHash" value={itemsHash} />
      <input type="hidden" name="checkoutKey" value={props.checkoutKey} />
      <input type="hidden" name="offerVersionId" value={props.documents.offerVersionId} />
      <input type="hidden" name="consentPdVersionId" value={props.documents.consentPdVersionId} />
      <input
        type="hidden"
        name="consentMarketingVersionId"
        value={props.documents.consentMarketingVersionId ?? ''}
      />
      <input type="hidden" name="expectedScheme" value={expectedScheme} />
      <input type="hidden" name="expectedPromisedDate" value={expectedPromisedDate ?? ''} />

      {blocked ? <Notice tone="wait">{props.blockedMessage}</Notice> : null}
      {formError ? (
        <Notice tone="danger" role="alert" data-testid="checkout-error">
          {formError}
        </Notice>
      ) : null}

      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
        <button
          type="submit"
          disabled={!canSubmit}
          className={cn(
            buttonClass({ variant: 'primary', size: 'lg' }),
            'w-full shrink-0 sm:w-auto',
          )}
        >
          {done ? 'Открываем заказ…' : pending ? 'Проверяем цены…' : 'Оформить заказ'}
          {!done && !pending ? <IconArrowRight size={18} /> : null}
        </button>
        <p className="min-w-0 text-sm text-muted">
          {!acceptOffer || !consentPd
            ? 'Кнопка станет активной, когда вы примете оферту и дадите согласие на обработку данных.'
            : 'Перед созданием заказа ещё раз сверим цену и наличие у поставщика.'}
        </p>
      </div>

      <noscript>
        <Notice tone="wait">
          Для оформления включите JavaScript
          {props.contactPhone ? ` или позвоните ${props.contactPhone}` : ' или позвоните нам'}.
        </Notice>
      </noscript>
    </form>
  );
}
