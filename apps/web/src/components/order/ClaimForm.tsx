'use client';

/**
 * The claim form of /o/<token> (docs/phase-1c-implementation.md section 10.3, decision С7): the
 * item or the whole order, the kind with plain-words hints, a description, up to 3 photos
 * (PhotoInput downscales them in the browser) and the last 4 phone digits (the counter of
 * wrong attempts is shared with the 1A cancellation and the 1B decisions).
 *
 * A real multipart form: with JavaScript it is posted by fetch and the errors stay next to the
 * fields (the text and the photos are not lost); without JavaScript the browser posts it and
 * the server answers 303 back to the page with a flash message.
 *
 * Demo (decision С21): the form is a GET to /o/demo?demo=claim, and the fields that could carry
 * personal data (the description, the digits, the photos) have no `name`, so the browser sends
 * nothing of them anywhere; only the kind and the item, which are not personal, reach the URL.
 */
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { IconAlert } from '@/components/icons';
import { PhotoInput } from '@/components/forms/PhotoInput';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { inputClass } from '@/components/ui/Input';

export interface ClaimFormProps {
  /** /api/orders/<token>/claims */
  action: string;
  requestKey: string;
  kinds: { kind: string; label: string; hint: string }[];
  targets: { value: string; label: string }[];
  maxPhotos: number;
  maxFileMb: number;
  textMax: number;
  /** The sample order: a GET to the demo screen, the personal fields are never sent. */
  demo?: boolean;
  contactPhone?: string | null;
}

interface ClaimResponse {
  error?: string;
  message?: string;
  attemptsLeft?: number;
}

/** The demo screen of an accepted claim (app/(site)/o/demo). */
const DEMO_ACTION = '/o/demo';

const GENERIC_ERROR = 'Не получилось отправить претензию. Попробуйте ещё раз или позвоните нам';

/** Text under the form for a failed request (exported for tests). */
export function claimErrorText(status: number, body: ClaimResponse | null): string {
  if (status === 422 && body?.error === 'wrong_digits' && typeof body.attemptsLeft === 'number') {
    return body.attemptsLeft > 0
      ? `Цифры не совпадают с номером телефона из заказа. Осталось попыток: ${body.attemptsLeft}`
      : 'Цифры не совпадают с номером телефона из заказа. Попытки закончились — попробуйте через час или позвоните нам';
  }
  if (status === 413 && !body?.message)
    return 'Фото слишком большие — уменьшите их или пришлите меньше';
  return body?.message ?? GENERIC_ERROR;
}

const OPTION =
  'flex min-w-0 cursor-pointer items-start gap-3 rounded border border-line bg-card px-4 py-3 transition-colors hover:border-ink has-checked:border-ink has-checked:bg-paper-2';

export function ClaimForm({
  action,
  requestKey,
  kinds,
  targets,
  maxPhotos,
  maxFileMb,
  textMax,
  demo = false,
  contactPhone = null,
}: ClaimFormProps) {
  const router = useRouter();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    // The demo navigates natively to its screen (nothing personal is named in the form).
    if (demo) return;
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (!/^\d{4}$/.test(String(data.get('last4') ?? ''))) {
      setError('Введите последние 4 цифры телефона');
      return;
    }
    if (!data.get('kind')) {
      setError('Выберите вид претензии');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch(action, {
        method: 'POST',
        body: data,
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
      });
      if (response.ok) {
        setDone(true);
        router.refresh();
        return;
      }
      let body: ClaimResponse | null = null;
      try {
        body = (await response.json()) as ClaimResponse;
      } catch {
        body = null;
      }
      setError(claimErrorText(response.status, body));
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p className="font-medium" role="status" data-testid="claim-done">
        Претензия принята. Порядок действий — выше.
      </p>
    );
  }

  return (
    <form
      method={demo ? 'get' : 'post'}
      action={demo ? DEMO_ACTION : action}
      encType={demo ? undefined : 'multipart/form-data'}
      onSubmit={(event) => void onSubmit(event)}
      noValidate={demo}
      className="space-y-5"
      data-testid="claim-form"
    >
      {demo ? (
        <input type="hidden" name="demo" value="claim" />
      ) : (
        <input type="hidden" name="requestKey" value={requestKey} />
      )}

      {targets.length > 1 ? (
        <fieldset className="min-w-0 space-y-2">
          <legend className="mb-1.5 text-sm font-medium">Что не так</legend>
          {targets.map((target, index) => (
            <label key={target.value || 'order'} className={OPTION}>
              <input
                type="radio"
                name="itemId"
                value={target.value}
                defaultChecked={index === 0}
                className="mt-1 size-4 shrink-0 accent-ink"
                data-testid="claim-target"
              />
              <span className="min-w-0 wrap-anywhere">{target.label}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <input type="hidden" name="itemId" value={targets[0]?.value ?? ''} />
      )}

      <fieldset className="min-w-0 space-y-2">
        <legend className="mb-1.5 text-sm font-medium">Вид претензии</legend>
        {kinds.map((kind, index) => (
          <label key={kind.kind} className={OPTION}>
            <input
              type="radio"
              name="kind"
              value={kind.kind}
              required
              defaultChecked={kinds.length === 1 && index === 0}
              className="mt-1 size-4 shrink-0 accent-ink"
              data-testid={`claim-kind-${kind.kind}`}
            />
            <span className="min-w-0">
              <span className="block font-medium">{kind.label}</span>
              <span className="block text-sm text-muted">{kind.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="min-w-0">
        <label htmlFor={`${id}-text`} className="mb-1.5 block text-sm font-medium">
          Опишите, что случилось
        </label>
        <textarea
          id={`${id}-text`}
          name={demo ? undefined : 'text'}
          rows={4}
          maxLength={textMax}
          className={cn(inputClass(), 'h-auto min-h-28 py-3 leading-relaxed')}
          aria-describedby={`${id}-text-hint`}
          data-testid="claim-text"
        />
        <p id={`${id}-text-hint`} className="mt-1.5 text-sm text-muted">
          До {textMax} символов. Не пишите сюда номера документов и карт — они не нужны.
        </p>
      </div>

      {maxPhotos > 0 ? (
        <PhotoInput
          name={demo ? '' : 'photos'}
          label="Фото детали и упаковки (необязательно)"
          max={maxPhotos}
          maxFileMb={maxFileMb}
          disabled={pending}
        />
      ) : null}

      <div className="min-w-0">
        <label htmlFor={`${id}-last4`} className="mb-1.5 block text-sm font-medium">
          Последние 4 цифры телефона из заказа
        </label>
        <input
          id={`${id}-last4`}
          name={demo ? undefined : 'last4'}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{4}"
          maxLength={4}
          required
          className={inputClass({
            mono: true,
            className: 'h-12 max-w-36 text-center text-lg tracking-[0.4em]',
          })}
          data-testid="claim-last4"
        />
      </div>

      {error !== null ? (
        <p
          className="flex items-start gap-1.5 text-sm text-danger"
          role="alert"
          data-testid="claim-error"
        >
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      ) : null}

      <div className="space-y-2">
        <button
          type="submit"
          disabled={pending}
          className={cn(buttonClass({ variant: 'primary' }), 'w-full sm:w-auto')}
          data-testid="claim-submit"
        >
          {pending ? 'Отправляем…' : 'Отправить претензию'}
        </button>
        {contactPhone ? (
          <p className="text-sm text-muted">Удобнее голосом — позвоните {contactPhone}.</p>
        ) : null}
      </div>
    </form>
  );
}
