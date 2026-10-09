'use client';

/**
 * The fit check form (step 4, docs/fit-check.md): the VIN (pre-filled with the last VIN of this
 * cart), an optional «Комментарий для мастера», the cart lines to check (the line the form was
 * opened from is ticked; «Все детали» ticks every line), the honeypot and «Отправить мастеру»
 * with the promise of the answer under it.
 *
 * Without JavaScript it is a plain urlencoded post to /api/fit-checks?line=<id>; the server
 * answers 303 back to the cart. With JavaScript the same fields go by fetch with
 * `Accept: application/json`, the sheet closes and the page re-renders (the line shows
 * «Мастер проверяет»). DEMO_MODE: the VIN never leaves the browser. The fields have no names, so
 * even a submit without JavaScript sends nothing but the line (a GET of /cart?fit_demo=<line>);
 * with JavaScript nothing is sent at all and the page shows the demo answer by itself.
 */
import { normalizeVin } from '@detaly/vin/vin';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent } from 'react';
import { IconArrowRight, IconCheck, IconClock } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { Spinner, buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { inputClass } from '@/components/ui/Input';
import type { FitShared } from '@/server/fit-checks/cart-fit';
import { FIT_CHECKS_PATH, fitAnchor, fitFormAction } from '@/server/fit-checks/paths';
import { FitClosed } from './FitClosed';
import { useFitSheet } from './FitSheet';

/** A cart line in the list of the form. */
export interface FitFormLine {
  id: string;
  /** «MANN W914/2» */
  title: string;
  name: string;
  /** A check of it waits for the master: it cannot be sent again now. */
  pending: boolean;
}

const LABEL = 'mb-2 block text-[0.9375rem] leading-snug font-semibold text-ink';
const OPTIONAL = 'font-medium text-muted';
const HINT = 'mt-2 text-small font-normal text-muted';
const TEXTAREA = cn(
  'block min-h-24 w-full min-w-0 resize-y rounded-control border-[1.5px] border-faint bg-surface px-4 py-3 text-[1.0625rem] leading-relaxed text-ink',
  'transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-muted hover:border-muted',
  'focus:border-brand focus:bg-bg focus-visible:shadow-[0_0_0_2px_var(--color-bg),0_0_0_5px_var(--color-brand)] focus-visible:outline-none',
);
const BOX =
  'peer size-6 cursor-pointer appearance-none rounded-md border-2 border-muted bg-bg transition-colors checked:border-brand checked:bg-brand disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-2';

function CheckBox(props: {
  name?: string;
  value?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  return (
    // The box's own target is 44×44 around the 24 px square (as the /vin consent).
    <span className="relative -m-2.5 grid size-11 shrink-0 place-items-center">
      <input
        type="checkbox"
        name={props.name}
        value={props.value}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        className={BOX}
        data-testid={props.testId}
      />
      <IconCheck
        size={18}
        strokeWidth={2.5}
        className="pointer-events-none absolute hidden text-on-brand peer-checked:block"
      />
    </span>
  );
}

interface ApiBody {
  error?: string;
  message?: string;
}

export function FitCheckForm({
  lineId,
  lines,
  shared,
  error = null,
  onDemoSent,
}: {
  /** The line the form was opened from: ticked, and where the answer comes back to. */
  lineId: string;
  lines: readonly FitFormLine[];
  shared: FitShared;
  /** The message of a form post without JavaScript that came back (`?fit_error=`). */
  error?: string | null;
  /** DEMO_MODE with JavaScript: the ticked lines (nothing is sent). */
  onDemoSent?: (lineIds: string[]) => void;
}) {
  const router = useRouter();
  const sheet = useFitSheet();
  const id = useId();
  const vinRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(error);
  const [pending, setPending] = useState(false);
  const open = lines.filter((line) => !line.pending);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(open.some((line) => line.id === lineId) ? [lineId] : []),
  );
  const allTicked = open.length > 0 && open.every((line) => ticked.has(line.id));

  if (!shared.open) return <FitClosed message={shared.closedMessage} phone={shared.phone} />;

  const demo = shared.demo;
  // DEMO_MODE: no field has a name, so a post without JavaScript carries the line only.
  const named = (name: string) => (demo ? undefined : name);

  function tick(lineIdToTick: string, on: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(lineIdToTick);
      else next.delete(lineIdToTick);
      return next;
    });
  }

  function tickAll(on: boolean) {
    setTicked(on ? new Set(open.map((line) => line.id)) : new Set([lineId]));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const chosen = open.filter((line) => ticked.has(line.id)).map((line) => line.id);
    if (demo) {
      // The VIN is checked here and goes nowhere.
      if (normalizeVin(vinRef.current?.value ?? '') === null) {
        setMessage(shared.messages.vin);
        return;
      }
      if (chosen.length === 0) {
        setMessage(shared.messages.lines);
        return;
      }
      setMessage(null);
      onDemoSent?.(chosen);
      sheet.close(fitAnchor(lineId));
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const body = new URLSearchParams();
      for (const [name, value] of new FormData(event.currentTarget)) {
        if (typeof value === 'string') body.append(name, value);
      }
      const response = await fetch(fitFormAction(lineId), {
        method: 'POST',
        body,
        headers: { Accept: 'application/json' },
      });
      const answer = (await response.json().catch(() => ({}))) as ApiBody;
      if (response.ok) {
        // The line says «Мастер проверяет» after the refresh: the focus waits on it.
        sheet.close(fitAnchor(lineId));
        router.refresh();
        return;
      }
      setMessage(answer.message ?? shared.messages.internal);
    } catch {
      setMessage(shared.messages.internal);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      method={demo ? 'get' : 'post'}
      action={demo ? `/cart#${fitAnchor(lineId)}` : fitFormAction(lineId)}
      onSubmit={sheet.enhanced ? (event) => void onSubmit(event) : undefined}
      className="relative min-w-0 space-y-5"
      data-testid="fit-form"
      data-action={demo ? 'demo' : FIT_CHECKS_PATH}
    >
      {demo ? (
        <input type="hidden" name="fit_demo" value={lineId} />
      ) : (
        <input type="hidden" name="line" value={lineId} />
      )}
      {message ? (
        <Notice tone="danger" role="alert" data-testid="fit-form-error">
          {message}
        </Notice>
      ) : null}

      <div className="min-w-0">
        <label htmlFor={`${id}-vin`} className={LABEL}>
          VIN автомобиля
        </label>
        <input
          ref={vinRef}
          id={`${id}-vin`}
          name={named('vin')}
          type="text"
          required
          minLength={17}
          maxLength={24}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          defaultValue={shared.lastVin ?? undefined}
          placeholder="17 символов из СТС"
          aria-describedby={`${id}-vin-hint`}
          className={inputClass({
            mono: true,
            className:
              'font-bold tracking-[0.08em] uppercase placeholder:font-medium placeholder:tracking-normal placeholder:normal-case',
          })}
          data-testid="fit-vin"
        />
        <p id={`${id}-vin-hint`} className={HINT}>
          {demo
            ? 'Демо: VIN не уйдёт с этой страницы — покажем, как выглядит ответ мастера.'
            : 'VIN увидит только мастер. Букв O, I и Q в VIN не бывает.'}
        </p>
      </div>

      <div className="min-w-0">
        <label htmlFor={`${id}-comment`} className={LABEL}>
          Комментарий для мастера <span className={OPTIONAL}>(необязательно)</span>
        </label>
        <textarea
          id={`${id}-comment`}
          name={named('comment')}
          maxLength={shared.commentMax}
          rows={2}
          placeholder="Например: двигатель 1.6, 2019"
          className={TEXTAREA}
          data-testid="fit-comment"
        />
      </div>

      <fieldset className="min-w-0">
        <legend className={LABEL}>Что проверить</legend>
        <ul className="min-w-0 divide-y divide-line rounded-control border border-line bg-bg">
          {lines.map((line) => (
            <li key={line.id} className="min-w-0">
              <label
                className={cn(
                  'flex min-h-12 min-w-0 items-center gap-3 px-3 py-2',
                  line.pending ? 'cursor-not-allowed text-muted' : 'cursor-pointer',
                )}
              >
                <CheckBox
                  name={named('lines')}
                  value={line.id}
                  checked={!line.pending && ticked.has(line.id)}
                  disabled={line.pending}
                  onChange={(on) => tick(line.id, on)}
                  testId={`fit-line-${line.id}`}
                />
                <span className="min-w-0">
                  <span className="block font-semibold wrap-anywhere">{line.title}</span>
                  <span className="block text-small font-normal text-muted wrap-anywhere">
                    {line.pending ? 'Мастер уже проверяет' : line.name}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {open.length > 1 ? (
          <label className="mt-2 flex min-h-12 min-w-0 cursor-pointer items-center gap-3 px-3 py-2">
            <CheckBox
              name={named('all')}
              value="on"
              checked={allTicked}
              onChange={tickAll}
              testId="fit-all"
            />
            <span className="font-semibold">Все детали корзины</span>
          </label>
        ) : null}
      </fieldset>

      {demo ? null : (
        // Honeypot: off screen, skipped by keyboard and screen readers; people never fill it.
        <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label htmlFor={`${id}-website`}>Сайт</label>
          <input id={`${id}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" />
        </div>
      )}

      <div className="min-w-0 space-y-3">
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending || undefined}
          className={cn(buttonClass({ variant: 'primary', size: 'lg', block: true }))}
          data-testid="fit-submit"
        >
          {pending ? <Spinner /> : null}
          {pending ? 'Отправляем…' : 'Отправить мастеру'}
          {pending ? null : <IconArrowRight size={20} />}
        </button>
        <p
          className="flex min-w-0 items-start gap-2 text-small font-normal text-muted"
          data-testid="fit-promise"
        >
          <IconClock size={18} className="mt-0.5 shrink-0 text-brand" />
          <span className="min-w-0">{shared.promiseText}</span>
        </p>
      </div>
    </form>
  );
}
