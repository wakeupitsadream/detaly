'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { IconAlert } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { inputClass } from '@/components/ui/Input';

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

  const openClass = cn(
    buttonClass({ variant: tone, size: tone === 'primary' ? 'lg' : 'md' }),
    'max-w-full py-2 text-left wrap-anywhere',
  );
  const submitClass =
    tone === 'danger'
      ? 'inline-flex min-h-11 items-center justify-center rounded bg-danger px-5 py-2 font-semibold text-card transition-colors hover:bg-danger/90 disabled:opacity-60'
      : cn(buttonClass({ variant: 'primary' }), 'py-2');

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
        <form
          onSubmit={(event) => void onSubmit(event)}
          noValidate
          className="space-y-3 rounded-sm border border-dashed border-line-strong bg-paper p-4"
        >
          <p className="wrap-anywhere">{confirmText}</p>
          {digits ? (
            <>
              <label htmlFor={inputId} className="block text-sm font-medium">
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
                className={inputClass({
                  mono: true,
                  className: 'h-12 w-36 text-center text-lg tracking-[0.4em]',
                })}
                data-testid={`${testId}-last4`}
              />
            </>
          ) : null}
          {error !== null ? (
            <p
              id={`${inputId}-error`}
              className="flex items-start gap-1.5 text-sm text-danger"
              role="alert"
              data-testid={`${testId}-error`}
            >
              <IconAlert size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{error}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              ref={submitRef}
              disabled={pending}
              className={submitClass}
              data-testid={`${testId}-submit`}
            >
              {pending ? pendingLabel : submitLabel}
            </button>
            <button
              type="button"
              disabled={pending}
              className={cn(buttonClass({ variant: 'ghost' }), 'text-muted')}
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
