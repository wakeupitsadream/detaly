/**
 * Shared answers of the phase 1C admin handlers (VIN request actions, admin files): Basic auth
 * again after the proxy, short HTML pages for refused forms, 303 back with a flash message.
 */
import type { Env } from '@detaly/config';
import { ADMIN_CHALLENGE, ADMIN_RESPONSE_HEADERS, checkAdminAuth } from '../admin-auth';
import { escapeHtml } from '../vin/http';

/** 404 without ADMIN_BASIC_AUTH, 401 with the challenge for missing or wrong credentials. */
export function adminAuthFailure(request: Request, env: Pick<Env, 'ADMIN_BASIC_AUTH'>) {
  const auth = checkAdminAuth(request.headers, env.ADMIN_BASIC_AUTH);
  if (auth === 'ok') return null;
  if (auth === 'disabled') {
    return new Response('Not Found', { status: 404, headers: ADMIN_RESPONSE_HEADERS });
  }
  return new Response('Нужны логин и пароль администратора', {
    status: 401,
    headers: {
      ...ADMIN_RESPONSE_HEADERS,
      'WWW-Authenticate': ADMIN_CHALLENGE,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

/** A refused admin form as a short page with a link back. */
export function adminPage(status: number, message: string, back: { href: string; label: string }) {
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Действие не выполнено</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;margin:0;padding:48px 16px;color:#1c1917;background:#fafaf9}main{max-width:36rem;margin:0 auto}h1{font-size:1.5rem}a{color:#b45309}</style>
</head><body><main>
<h1>Действие не выполнено</h1>
<p data-testid="admin-action-error">${escapeHtml(message)}</p>
<p><a href="${escapeHtml(back.href)}">${escapeHtml(back.label)}</a></p>
</main></body></html>`;
  return new Response(html, {
    status,
    headers: { ...ADMIN_RESPONSE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** 303 to an admin page with `done=<message>` (after the page's own query, if any). */
export function adminDone(path: string, message: string): Response {
  const joiner = path.includes('?') ? '&' : '?';
  const location = `${path}${joiner}done=${encodeURIComponent(message.slice(0, 300))}`;
  return new Response(null, {
    status: 303,
    headers: { ...ADMIN_RESPONSE_HEADERS, Location: location },
  });
}
