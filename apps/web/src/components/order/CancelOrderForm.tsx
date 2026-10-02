'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { IconAlert } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { inputClass } from '@/components/ui/Input';

interface CancelResponse {
  error?: string;
  message?: string;
  attemptsLeft?: number;
}

const GENERIC_ERROR = 'Не получилось отменить заказ. Попробуйте ещё раз или позвоните нам';

/** Text under the form for a failed request (exported for tests). */
export function cancelErrorText(status: number, body: CancelResponse | null): string {
  if (status === 422 && body?.error === 'wrong_digits') {
    const left = body.attemptsLeft;
    if (typeof left === 'number') {
      return left > 0
        ? `Цифры не совпадают с номером телефона из заказа. Осталось попыток: ${left}`
        : 'Цифры не совпадают с номером телефона из заказа. Попытки закончились — попробуйте через час или позвоните нам';
    }
  }
  return body?.message ?? GENERIC_ERROR;
}

/**
 * «Отменить заказ» on /o/<token>: expands into a field for the last 4 phone digits and posts
 * them to /api/orders/<token>/cancel. On success the server component re-renders
 * (router.refresh) with the cancelled status. Requires JavaScript (decision Д20).
 */
export function CancelOrderForm({
  token,
  contactPhone,
}: {
  token: string;
  contactPhone: string | null;
}) {
  const router = useRouter();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [last4, setLast4] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  // Where focus goes after the block expands or collapses: the button that had it is removed
  // from the DOM, so without this keyboard and screen reader users land on <body>.
  const focusNext = useRef<'input' | 'open' | null>(null);

  useEffect(() => {
    if (focusNext.current === 'input') inputRef.current?.focus();
    else if (focusNext.current === 'open') openButtonRef.current?.focus();
    focusNext.current = null;
  }, [open]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{4}$/.test(last4)) {
      setError('Введите последние 4 цифры телефона');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(token)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ last4 }),
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
      });
      if (response.ok) {
        setDone(true);
        router.refresh();
        return;
      }
      let body: CancelResponse | null = null;
      try {
        body = (await response.json()) as CancelResponse;
      } catch {
        body = null;
      }
      setError(cancelErrorText(response.status, body));
      if (response.status === 409) router.refresh();
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p className="font-semibold text-danger" role="status" data-testid="cancel-done">
        Заказ отменён
      </p>
    );
  }

  return (
    <section
      className="min-w-0 rounded border border-dashed border-danger/40 bg-card p-5 md:p-6"
      data-testid="order-cancel"
    >
      <p className="mb-4 text-sm text-muted">
        Передумали? Пока заказ не оплачен и не подтверждён, его можно отменить здесь.
      </p>
      <noscript>
        <p className="text-sm text-muted">
          Для отмены заказа включите JavaScript
          {contactPhone ? ` или позвоните ${contactPhone}` : ''}.
        </p>
      </noscript>
      {!open ? (
        <button
          type="button"
          className={buttonClass({ variant: 'danger' })}
          ref={openButtonRef}
          aria-expanded="false"
          onClick={() => {
            focusNext.current = 'input';
            setOpen(true);
          }}
          data-testid="cancel-open"
        >
          Отменить заказ
        </button>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-3">
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
            data-testid="cancel-last4"
          />
          {error !== null ? (
            <p
              id={`${inputId}-error`}
              className="flex items-start gap-1.5 text-sm text-danger"
              role="alert"
              data-testid="cancel-error"
            >
              <IconAlert size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{error}</span>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex min-h-11 items-center justify-center rounded bg-danger px-5 font-semibold text-card transition-colors hover:bg-danger/90 disabled:opacity-60"
              data-testid="cancel-submit"
            >
              {pending ? 'Отменяем…' : 'Отменить заказ'}
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
              Не отменять
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
