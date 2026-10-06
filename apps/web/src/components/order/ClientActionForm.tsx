'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { IconAlert } from '@/components/icons';
import { buttonClass, Spinner } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { inputClass } from '@/components/ui/Input';
import { ConfirmSheet } from './ConfirmSheet';

/** Client actions of POST /api/orders/<token>/actions (decision Б24). */
export type ClientActionCode =
  'confirm' | 'approve' | 'prepay_now' | 'refund_request' | 'refuse' | 'item_cancel';

interface ActionResponse {
  error?: string;
  message?: string;
  attemptsLeft?: number;
}

const GENERIC_ERROR = 'Не получилось выполнить действие. Попробуйте ещё раз или позвоните нам';

/** Text under the form for a failed request (exported for tests). */
export function actionErrorText(status: number, body: ActionResponse | null): string {
  if (status === 422 && body?.error === 'wrong_digits') {
    const left = body.attemptsLeft;
    if (typeof left === 'number') {
      return left > 0
        ? `Цифры не совпадают с номером телефона из заказа. Осталось попыток: ${left}`
        : 'Цифры не совпадают с номером телефона из заказа. Попытки закончились — попробуйте через час или позвоните нам';
    }
  }
  if (status === 429 && body?.message) return body.message;
  return body?.message ?? GENERIC_ERROR;
}

export interface ClientActionFormProps {
  token: string;
  action: ClientActionCode;
  itemId?: string;
  /** Destructive action: the last 4 phone digits are required. */
  digits: boolean;
  /** The first button. */
  openLabel: string;
  /** What happens, shown before the final click. */
  confirmText: string;
  submitLabel: string;
  pendingLabel: string;
  doneText: string;
  /**
   * primary: the main decision of the page; secondary: an outlined button; danger: a
   * refusal (red outline, red final button).
   */
  tone?: 'primary' | 'secondary' | 'danger';
  testId: string;
  contactPhone?: string | null;
  /** The first button across its column at every width (the actions row at the bottom). */
  block?: boolean;
}

/** The final button of a refusal: the danger fill, white text (5.6:1). */
export const DANGER_SUBMIT =
  'inline-flex min-h-13 items-center justify-center gap-2 rounded-control bg-danger px-6 text-[1.0625rem] font-semibold text-on-brand transition-colors hover:bg-danger/90 disabled:opacity-60';

/** The 4 digits field: large, centred, spaced. */
export const LAST4_INPUT = 'h-16 w-44 text-center text-[1.5rem] font-bold tracking-[0.4em]';

/**
 * A client decision on /o/<token>: a button that opens the confirmation in a sheet
 * (ConfirmSheet: what happens, and the field for the last 4 phone digits for destructive
 * actions), then a JSON POST to /api/orders/<token>/actions and router.refresh(). Requires
 * JavaScript, as the 1A cancellation (decision Д20).
 */
export function ClientActionForm({
  token,
  action,
  itemId,
  digits,
  openLabel,
  confirmText,
  submitLabel,
  pendingLabel,
  doneText,
  tone = 'secondary',
  testId,
  contactPhone = null,
  block = false,
}: ClientActionFormProps) {
  const router = useRouter();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [last4, setLast4] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Back to the button that opened the sheet when it closes (keyboard and screen readers).
  useEffect(() => {
    if (!open && wasOpen.current) openButtonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  function close() {
    if (pending) return;
    setOpen(false);
    setError(null);
    setLast4('');
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (digits && !/^\d{4}$/.test(last4)) {
      setError('Введите последние 4 цифры телефона');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(token)}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          action,
          ...(itemId ? { itemId } : {}),
          ...(digits ? { last4 } : {}),
        }),
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
      });
      if (response.ok) {
        setDone(true);
        router.refresh();
        return;
      }
      let body: ActionResponse | null = null;
      try {
        body = (await response.json()) as ActionResponse;
      } catch {
        body = null;
      }
      setError(actionErrorText(response.status, body));
      if (response.status === 409) router.refresh();
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p className="text-body font-semibold text-ok" role="status" data-testid={`${testId}-done`}>
        {doneText}
      </p>
    );
  }

  const openClass = cn(
    buttonClass({
      variant: tone,
      size: tone === 'primary' ? 'lg' : 'md',
    }),
    'w-full max-w-full py-2 wrap-anywhere',
    !block && 'sm:w-auto',
  );
  const submitClass =
    tone === 'danger' ? DANGER_SUBMIT : buttonClass({ variant: 'primary', size: 'lg' });

  return (
    <div className="min-w-0" data-testid={testId}>
      <noscript>
        <p className="text-small text-muted">
          Для этого действия включите JavaScript
          {contactPhone ? ` или позвоните ${contactPhone}` : ''}.
        </p>
      </noscript>
      <button
        type="button"
        className={openClass}
        ref={openButtonRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        data-testid={`${testId}-open`}
      >
        {openLabel}
      </button>
      {open ? (
        <ConfirmSheet title={openLabel} onClose={close}>
          <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-4">
            <p className="wrap-anywhere">{confirmText}</p>
            {digits ? (
              <div>
                <label htmlFor={inputId} className="mb-2 block text-[0.9375rem] font-semibold">
                  Последние 4 цифры телефона из заказа
                </label>
                <input
                  id={inputId}
                  name="last4"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  required
                  value={last4}
                  onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  aria-invalid={error !== null}
                  aria-describedby={error !== null ? `${inputId}-error` : undefined}
                  className={inputClass({ mono: true, className: LAST4_INPUT })}
                  data-testid={`${testId}-last4`}
                  data-autofocus
                />
              </div>
            ) : null}
            {error !== null ? (
              <p
                id={`${inputId}-error`}
                className="flex items-start gap-1.5 text-small font-medium text-danger"
                role="alert"
                data-testid={`${testId}-error`}
              >
                <IconAlert size={18} className="mt-0.5 shrink-0" />
                <span className="min-w-0">{error}</span>
              </p>
            ) : null}
            <div className="flex flex-col gap-2 pt-1 sm:flex-row">
              <button
                type="submit"
                disabled={pending}
                aria-busy={pending || undefined}
                className={submitClass}
                data-testid={`${testId}-submit`}
                data-autofocus={digits ? undefined : true}
              >
                {pending ? <Spinner /> : null}
                {pending ? pendingLabel : submitLabel}
              </button>
              <button
                type="button"
                disabled={pending}
                className={buttonClass({ variant: 'secondary', size: 'lg' })}
                onClick={close}
              >
                Назад
              </button>
            </div>
          </form>
        </ConfirmSheet>
      ) : null}
    </div>
  );
}
