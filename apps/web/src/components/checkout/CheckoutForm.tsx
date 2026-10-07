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
import { buttonClass, Spinner } from '@/components/ui/Button';
import { ChoiceCard } from '@/components/ui/ChoiceCard';
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
  /**
   * DEMO_MODE: the same form filled with an example, no request at all. The button opens the
   * sample order (`href`); POST /api/checkout stays closed (403) in the demo anyway.
   */
  demo?: { href: string };
  /** Step «Получение»: the pickup point card (server-rendered, refreshed with the page). */
  receive?: ReactNode;
  /** Step «Оплата»: the payment scheme card. */
  payment?: ReactNode;
  /** The order's lines and total, shown before the consents. */
  summary?: ReactNode;
}

/** Example values of the demo form: obviously not a person. */
export const DEMO_FORM_EXAMPLE = { phone: '+7 999 123-45-67', name: 'Алексей' } as const;

/**
 * The same order and look as «Куда прислать ответ» of /vin. MAX is «скоро» as on the order page
 * (MessengerBlock draws it as an inactive stub until phase 2): no one picks a channel that never
 * sends a status.
 */
const CHANNELS: readonly { value: string; label: string; Icon: IconComponent; soon: boolean }[] = [
  { value: 'telegram', label: 'Telegram', Icon: IconTelegram, soon: false },
  { value: 'sms', label: 'SMS', Icon: IconMessage, soon: false },
  { value: 'max', label: 'MAX', Icon: IconMax, soon: true },
];

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

const LABEL = 'mb-2 block text-[0.9375rem] leading-snug font-semibold text-ink';
const DOC_LINK =
  'font-semibold text-brand underline decoration-1 underline-offset-4 hover:text-brand-hover hover:decoration-2';

/**
 * A step of the form: the step number in a neutral circle and the title, the content right under
 * it on the page (no box of its own: the content is cards and fields already).
 */
function Step({ index, title, children }: { index?: string; title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 pt-2">
      <SheetTitle index={index}>{title}</SheetTitle>
      {children}
    </section>
  );
}

/**
 * A consent checkbox: a 24 px rounded square, brand fill with a white tick when checked, the
 * whole row (48 px at least) is the label. The native input stays in place (keyboard, form
 * data, the label as its name), only its look changes.
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
    <label className="flex min-h-12 cursor-pointer items-start gap-3 py-1.5 text-body leading-snug">
      <span className="relative grid size-6 shrink-0 place-items-center">
        <input
          type="checkbox"
          name={name}
          className="peer size-6 cursor-pointer appearance-none rounded-[7px] border-2 border-muted bg-bg transition-colors hover:border-muted checked:border-brand checked:bg-brand focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand"
          aria-describedby={describedBy}
          {...controlled}
        />
        <IconCheck
          size={18}
          strokeWidth={2.75}
          className="pointer-events-none absolute hidden text-on-brand peer-checked:block"
        />
      </span>
      <span className="min-w-0">{children}</span>
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
  const demo = props.demo ?? null;
  const [acceptOffer, setAcceptOffer] = useState(demo !== null);
  const [consentPd, setConsentPd] = useState(demo !== null);
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
    if (demo !== null) {
      window.location.assign(demo.href);
      return;
    }
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
      className="min-w-0 space-y-6 md:space-y-8"
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
          <p className="text-small font-normal text-muted">
            {schemeNotice !== null && changes === null
              ? 'Заказ не оформлен. Проверьте способ оплаты и отправьте форму ещё раз.'
              : 'Заказ не оформлен. Мы обновили данные заказа — проверьте их и отправьте форму ещё раз.'}
          </p>
        </div>
      ) : null}

      <Step index="01" title="Контакты">
        <div className="grid min-w-0 gap-5">
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
              placeholder="Ваш мобильный"
              defaultValue={demo ? DEMO_FORM_EXAMPLE.phone : undefined}
              aria-invalid={fieldErrors.phone ? true : undefined}
              aria-describedby="checkout-phone-hint checkout-phone-error"
              className={inputClass({ className: 'tabular-nums' })}
            />
            <p id="checkout-phone-hint" className="mt-2 text-small font-normal text-muted">
              Мобильный, например +7 912 345-67-89: по нему выдадим заказ.
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
              defaultValue={demo ? DEMO_FORM_EXAMPLE.name : undefined}
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby="checkout-name-error"
              className={inputClass()}
            />
            <FieldError id="checkout-name-error" message={fieldErrors.name} />
          </div>
          <fieldset className="min-w-0">
            <legend className={LABEL}>Куда присылать статусы заказа</legend>
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              {CHANNELS.map(({ value, label, Icon, soon }) => (
                <ChoiceCard
                  key={value}
                  name="channel"
                  value={value}
                  label={label}
                  Icon={Icon}
                  soon={soon}
                  defaultChecked={demo !== null && value === 'telegram'}
                  required
                  describedBy="checkout-channel-error"
                />
              ))}
            </div>
            <p className="mt-2 text-small font-normal text-muted">
              Включите одной кнопкой на странице заказа.
            </p>
            <FieldError id="checkout-channel-error" message={fieldErrors.channel} />
          </fieldset>
        </div>
      </Step>

      {props.receive ? (
        <Step index="02" title="Получение">
          {props.receive}
        </Step>
      ) : null}

      {props.payment ? (
        <Step index={props.receive ? '03' : '02'} title="Оплата">
          {props.payment}
        </Step>
      ) : null}

      {props.summary}

      <section
        className="min-w-0 space-y-1 rounded-tile bg-surface p-4 md:px-6"
        aria-label="Согласия"
      >
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
            Хочу получать скидки (
            <a className={DOC_LINK} href="/docs/consent-marketing" target="_blank" rel="noopener">
              согласие
            </a>
            , необязательно)
          </Consent>
        ) : null}
      </section>

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

      {demo !== null ? (
        <div className="min-w-0 space-y-3">
          <a
            href={demo.href}
            className={buttonClass({ variant: 'primary', size: 'lg', block: true })}
            data-testid="demo-checkout-submit"
          >
            Оформить заказ
            <IconArrowRight size={20} />
          </a>
          <p className="text-small font-normal text-muted">
            Демо: заказ не создаётся, покажем пример страницы заказа.
          </p>
        </div>
      ) : (
        <div className="min-w-0 space-y-3">
          <button
            type="submit"
            disabled={!canSubmit}
            aria-busy={pending || done || undefined}
            className={buttonClass({ variant: 'primary', size: 'lg', block: true })}
          >
            {pending || done ? <Spinner /> : null}
            {done ? 'Открываем заказ…' : pending ? 'Проверяем цены…' : 'Оформить заказ'}
            {!done && !pending ? <IconArrowRight size={20} /> : null}
          </button>
          <p className="text-small font-normal text-muted">
            {!acceptOffer || !consentPd
              ? 'Кнопка включится, когда вы отметите оба согласия.'
              : 'Перед заказом ещё раз сверим цену и наличие.'}
          </p>
        </div>
      )}

      <noscript>
        <Notice tone="wait">
          Для оформления включите JavaScript
          {props.contactPhone ? ` или позвоните ${props.contactPhone}` : ' или позвоните нам'}.
        </Notice>
      </noscript>
    </form>
  );
}
