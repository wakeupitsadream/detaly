'use client';

/**
 * «Статусы в Telegram» (docs/phase-1c-implementation.md section 10.1). A real form posting to
 * /api/orders/<token>/link; with JavaScript it is sent by fetch asking for JSON and the browser
 * goes to the returned `t.me/<bot>?start=<link token>` with location.assign.
 *
 * Why not the plain 303: the site's CSP lists only 'self' and the payment page in form-action,
 * and Chromium applies form-action to the redirects of a form submission as well, so a 303 to
 * t.me after a native submit is refused («violates form-action»). A navigation by script is not
 * a form submission. Without JavaScript the native post still reaches the handler (a 303 that
 * browsers with the CSP refuse); `https://t.me` in form-action is listed as an open issue for
 * apps/web/src/lib/csp.ts. The demo is a plain GET to /o/demo?demo=link: nothing is created.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { IconAlert } from '@/components/icons';

const TELEGRAM_LINK_RE = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?start=[A-Za-z0-9_-]{1,64}$/;
const GENERIC_ERROR = 'Не получилось открыть бота. Попробуйте ещё раз через минуту';

export function TelegramLinkButton({
  action,
  demo = false,
  className,
  testId,
  selected,
  state,
  children,
}: {
  action: string;
  demo?: boolean;
  className: string;
  testId: string;
  selected: boolean;
  state: string;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (demo) return;
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
      });
      const body = (await response.json().catch(() => null)) as {
        redirectUrl?: unknown;
        message?: unknown;
      } | null;
      const url = typeof body?.redirectUrl === 'string' ? body.redirectUrl : '';
      if (response.ok && TELEGRAM_LINK_RE.test(url)) {
        window.location.assign(url);
        return;
      }
      setError(typeof body?.message === 'string' ? body.message : GENERIC_ERROR);
      setPending(false);
    } catch {
      setError(GENERIC_ERROR);
      setPending(false);
    }
  }

  return (
    <form
      method={demo ? 'get' : 'post'}
      action={demo ? '/o/demo' : action}
      className="min-w-0"
      onSubmit={(event) => void onSubmit(event)}
    >
      {demo ? (
        <input type="hidden" name="demo" value="link" />
      ) : (
        <input type="hidden" name="channel" value="telegram" />
      )}
      <button
        type="submit"
        className={className}
        disabled={pending}
        aria-busy={pending || undefined}
        data-testid={testId}
        data-selected={selected ? 'true' : 'false'}
        data-state={state}
      >
        {children}
      </button>
      {error !== null ? (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-danger" role="alert">
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      ) : null}
    </form>
  );
}
