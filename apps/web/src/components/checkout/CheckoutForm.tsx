'use client';

import type { LineChange, PaymentScheme } from '@detaly/domain';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DiffBanner } from '@/components/DiffBanner';
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
    <p id={id} className="text-sm text-accent-strong" role="alert">
      {message}
    </p>
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

  const inputClass =
    'h-12 w-full min-w-0 rounded-xl border border-line bg-card px-3 text-base focus:border-ink';

  return (
    <form className="space-y-5" onSubmit={(e) => void onSubmit(e)} data-testid="checkout-form">
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
            <p
              className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn"
              role="status"
              data-testid="checkout-promise-changed"
            >
              Срок получения изменился: {promise.text}
            </p>
          ) : null}
          {schemeNotice !== null ? (
            <div
              className="space-y-1 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn"
              role="status"
              data-testid="checkout-scheme-changed"
            >
              <p className="font-semibold">
                Способ оплаты: {PAYMENT_SCHEME_TITLE[schemeNotice.scheme]}
              </p>
              {schemeNotice.explanation.map((sentence) => (
                <p key={sentence}>{sentence}</p>
              ))}
            </div>
          ) : null}
          <p className="text-sm text-muted">
            {schemeNotice !== null && changes === null
              ? 'Заказ не оформлен. Проверьте способ оплаты и отправьте форму ещё раз.'
              : 'Заказ не оформлен. Мы обновили данные заказа — проверьте их и отправьте форму ещё раз.'}
          </p>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="checkout-phone" className="block font-medium">
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
          className={inputClass}
        />
        <p id="checkout-phone-hint" className="text-xs text-muted">
          Мобильный номер: +7 или 8 и 10 цифр. По нему вы получите заказ.
        </p>
        <FieldError id="checkout-phone-error" message={fieldErrors.phone} />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="checkout-name" className="block font-medium">
          Имя
        </label>
        <input
          id="checkout-name"
          name="name"
          type="text"
          autoComplete="name"
          required
          maxLength={60}
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby="checkout-name-error"
          className={inputClass}
        />
        <FieldError id="checkout-name-error" message={fieldErrors.name} />
      </div>

      <fieldset className="space-y-2">
        <legend className="font-medium">Куда присылать статусы заказа</legend>
        <div className="flex flex-wrap gap-2">
          {CHANNELS.map((channel) => (
            <label
              key={channel.value}
              className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-line bg-card px-4 has-[:checked]:border-ink"
            >
              <input type="radio" name="channel" value={channel.value} required />
              {channel.label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">
          Это предпочтение: подключить уведомления можно будет на странице заказа.
        </p>
        <FieldError id="checkout-channel-error" message={fieldErrors.channel} />
      </fieldset>

      <div className="space-y-3">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="acceptOffer"
            className="mt-1 size-5 shrink-0"
            checked={acceptOffer}
            onChange={(e) => setAcceptOffer(e.target.checked)}
            aria-describedby="checkout-offer-error"
          />
          <span>
            Принимаю условия{' '}
            <a className="underline" href="/docs/offer" target="_blank" rel="noopener">
              оферты
            </a>
          </span>
        </label>
        <FieldError id="checkout-offer-error" message={fieldErrors.acceptOffer} />
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="consentPd"
            className="mt-1 size-5 shrink-0"
            checked={consentPd}
            onChange={(e) => setConsentPd(e.target.checked)}
            aria-describedby="checkout-pd-error"
          />
          <span>
            Даю{' '}
            <a className="underline" href="/docs/consent" target="_blank" rel="noopener">
              согласие на обработку персональных данных
            </a>
          </span>
        </label>
        <FieldError id="checkout-pd-error" message={fieldErrors.consentPd} />
        {props.marketingAvailable ? (
          <label className="flex items-start gap-3">
            <input type="checkbox" name="consentMarketing" className="mt-1 size-5 shrink-0" />
            <span>
              Хочу получать предложения и скидки (
              <a
                className="underline"
                href="/docs/consent-marketing"
                target="_blank"
                rel="noopener"
              >
                согласие
              </a>
              , необязательно)
            </span>
          </label>
        ) : null}
      </div>

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

      {blocked ? (
        <p className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
          {props.blockedMessage}
        </p>
      ) : null}
      {formError ? (
        <p
          className="rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-sm text-accent-strong"
          role="alert"
          data-testid="checkout-error"
        >
          {formError}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-accent px-6 font-semibold text-white hover:bg-accent-strong disabled:cursor-not-allowed disabled:bg-faint md:w-auto"
      >
        {done ? 'Открываем заказ…' : pending ? 'Проверяем цены…' : 'Оформить заказ'}
      </button>
      {!acceptOffer || !consentPd ? (
        <p className="text-xs text-muted">
          Кнопка станет активной, когда вы примете оферту и дадите согласие на обработку данных.
        </p>
      ) : null}

      <noscript>
        <p className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
          Для оформления включите JavaScript
          {props.contactPhone ? ` или позвоните ${props.contactPhone}` : ' или позвоните нам'}.
        </p>
      </noscript>
    </form>
  );
}
