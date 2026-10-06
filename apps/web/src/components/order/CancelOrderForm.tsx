'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { IconAlert, IconClose } from '@/components/icons';
import { buttonClass, Spinner } from '@/components/ui/Button';
import { inputClass } from '@/components/ui/Input';
import { DANGER_SUBMIT, LAST4_INPUT } from './ClientActionForm';
import { ConfirmSheet } from './ConfirmSheet';

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
 * «Отменить заказ» on /o/<token>: a secondary button among the order's actions that opens a
 * sheet with the field for the last 4 phone digits and posts them to
 * /api/orders/<token>/cancel. On success the server component re-renders (router.refresh) with
 * the cancelled status. Requires JavaScript (decision Д20).
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
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Back to «Отменить заказ» when the sheet closes (keyboard and screen readers).
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
      <p className="text-body font-semibold text-danger" role="status" data-testid="cancel-done">
        Заказ отменён
      </p>
    );
  }

  return (
    <div className="min-w-0" data-testid="order-cancel">
      <noscript>
        <p className="text-small text-muted">
          Для отмены заказа включите JavaScript
          {contactPhone ? ` или позвоните ${contactPhone}` : ''}.
        </p>
      </noscript>
      <button
        type="button"
        className={buttonClass({ variant: 'secondary', block: true })}
        ref={openButtonRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        data-testid="cancel-open"
      >
        <IconClose size={20} className="text-danger" />
        Отменить заказ
      </button>
      {open ? (
        <ConfirmSheet title="Отменить заказ?" onClose={close}>
          <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-4">
            <p>Пока заказ не оплачен и не подтверждён, его можно отменить здесь.</p>
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
                data-testid="cancel-last4"
                data-autofocus
              />
            </div>
            {error !== null ? (
              <p
                id={`${inputId}-error`}
                className="flex items-start gap-1.5 text-small font-medium text-danger"
                role="alert"
                data-testid="cancel-error"
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
                className={DANGER_SUBMIT}
                data-testid="cancel-submit"
              >
                {pending ? <Spinner /> : null}
                {pending ? 'Отменяем…' : 'Отменить заказ'}
              </button>
              <button
                type="button"
                disabled={pending}
                className={buttonClass({ variant: 'secondary', size: 'lg' })}
                onClick={close}
              >
                Не отменять
              </button>
            </div>
          </form>
        </ConfirmSheet>
      ) : null}
    </div>
  );
}
