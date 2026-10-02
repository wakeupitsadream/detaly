'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

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
  /** primary: the main decision of the page; secondary: an outlined button. */
  tone?: 'primary' | 'secondary';
  testId: string;
  contactPhone?: string | null;
}

/**
 * A client decision on /o/<token>: a button that expands into a confirmation step (and the
 * field for the last 4 phone digits for destructive actions), then a JSON POST to
 * /api/orders/<token>/actions and router.refresh(). Requires JavaScript, as the 1A
 * cancellation (decision Д20).
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
}: ClientActionFormProps) {
  const router = useRouter();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [last4, setLast4] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<'input' | 'open' | null>(null);

  useEffect(() => {
    if (focusNext.current === 'input') (inputRef.current ?? submitRef.current)?.focus();
    else if (focusNext.current === 'open') openButtonRef.current?.focus();
    focusNext.current = null;
  }, [open]);

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
      <p className="font-medium" role="status" data-testid={`${testId}-done`}>
        {doneText}
      </p>
    );
  }

  const openClass =
    tone === 'primary'
      ? 'inline-flex min-h-11 max-w-full items-center justify-center rounded-xl bg-accent px-5 py-2 font-semibold text-white wrap-anywhere hover:bg-accent-strong'
      : 'inline-flex min-h-11 max-w-full items-center justify-center rounded-xl border border-line px-5 py-2 text-left font-medium text-ink wrap-anywhere hover:border-accent hover:text-accent';

  return (
    <div className="min-w-0" data-testid={testId}>
      <noscript>
        <p className="text-sm text-muted">
          Для этого действия включите JavaScript
          {contactPhone ? ` или позвоните ${contactPhone}` : ''}.
        </p>
      </noscript>
      {!open ? (
        <button
          type="button"
          className={openClass}
          ref={openButtonRef}
          aria-expanded="false"
          onClick={() => {
            focusNext.current = 'input';
            setOpen(true);
          }}
          data-testid={`${testId}-open`}
        >
          {openLabel}
        </button>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-3">
          <p className="wrap-anywhere">{confirmText}</p>
          {digits ? (
            <>
              <label htmlFor={inputId} className="block font-medium">
                Для подтверждения введите последние 4 цифры телефона
              </label>
              <input
                ref={inputRef}
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
                className="block h-11 w-32 rounded-xl border border-line bg-card px-3 font-mono text-lg tracking-widest"
                data-testid={`${testId}-last4`}
              />
            </>
          ) : null}
          {error !== null ? (
            <p
              id={`${inputId}-error`}
              className="text-sm text-accent-strong"
              role="alert"
              data-testid={`${testId}-error`}
            >
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              ref={submitRef}
              disabled={pending}
              className="inline-flex min-h-11 items-center rounded-xl bg-accent px-5 py-2 font-semibold text-white hover:bg-accent-strong disabled:opacity-60"
              data-testid={`${testId}-submit`}
            >
              {pending ? pendingLabel : submitLabel}
            </button>
            <button
              type="button"
              disabled={pending}
              className="inline-flex min-h-11 items-center rounded-xl border border-line px-5 py-2 font-medium text-muted"
              onClick={() => {
                focusNext.current = 'open';
                setOpen(false);
                setError(null);
                setLast4('');
              }}
            >
              Назад
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
