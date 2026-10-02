'use client';

import type { LineChange } from '@detaly/domain';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DiffBanner } from '@/components/DiffBanner';

type Field = 'phone' | 'name' | 'channel' | 'acceptOffer' | 'consentPd';

export interface CheckoutFormProps {
  part: 'all' | 'local' | 'order';
  expectedTotalKop: number;
  itemsHash: string;
  /** uuid v7 rendered by the server: one order per form, whatever the number of submits. */
  checkoutKey: string;
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

  useEffect(() => {
    setOverride(null);
  }, [props.expectedTotalKop, props.itemsHash]);

  // On a phone the submit button is far below the banner: bring a fresh 409 banner into view
  // and move focus there, so the client sees that the order was not created.
  const changesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (changes === null) return;
    const node = changesRef.current;
    node?.scrollIntoView({ block: 'center' });
    node?.focus({ preventScroll: true });
  }, [changes]);

  const expectedTotalKop = override?.totalKop ?? props.expectedTotalKop;
  const itemsHash = override?.itemsHash ?? props.itemsHash;
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
      {changes !== null ? (
        <div
          ref={changesRef}
          tabIndex={-1}
          className="space-y-2 outline-none"
          data-testid="checkout-stale"
        >
          <DiffBanner changes={changes} cartChanged />
          <p className="text-sm text-muted">
            Заказ не оформлен. Сумма и состав обновлены — проверьте их и отправьте форму ещё раз.
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
          Российский номер: +7 или 8 и 10 цифр. По нему вы получите заказ.
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
