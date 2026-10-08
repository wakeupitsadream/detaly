/**
 * Content-Security-Policy of the site (audit tech-3). Scripts run only with the nonce of their
 * response: src/proxy.ts makes a new nonce for every request and sends the policy twice, on the
 * response (for the browser) and on the request (Next reads the nonce from the request's
 * `content-security-policy` header and puts it on its own bootstrap, chunk and inline data
 * scripts: next/dist/server/app-render/get-script-nonce-from-header). 'strict-dynamic' lets the
 * chunks those scripts load run as well, so no 'unsafe-inline' is left in script-src; 'self'
 * stays only as the fallback of browsers without 'strict-dynamic'. No third-party script is
 * loaded at all. Styles keep 'unsafe-inline' (React style attributes; nothing executes there).
 *
 * Every page must be rendered per request for this: a page prerendered at build time carries no
 * nonce and its scripts would be refused (the (site) and admin layouts are force-dynamic, the
 * root not-found waits for a request with connection()).
 */

/**
 * Where «Оплатить N ₽» on /o/<token> sends the browser: the form posts to
 * /api/orders/<token>/pay, which answers 303 to YooKassa's confirmation_url. Browsers apply
 * form-action to the redirects of a form submission too (Chromium blocks the 303 with
 * «Refused to send form data … violates form-action»), so the payment page's origin must be
 * listed here. VERIFY: Ю11 — confirmation_url of a redirect payment is on yoomoney.ru
 * (reference examples: https://yoomoney.ru/checkout/payments/v2/contract?orderId=…).
 */
export const PAYMENT_FORM_ACTION_ORIGINS = ['https://yoomoney.ru', 'https://*.yoomoney.ru'];

/**
 * «Статусы в Telegram» on /o/<token> posts to /api/orders/<token>/link, which answers 303 to the
 * client bot's deep link https://t.me/<bot>?start=<payload>; without t.me here the no-script form
 * path is refused by form-action (the button navigates by script otherwise). VERIFY: deep links
 * of the client bot stay on https://t.me (docs/external.md section 8).
 */
export const MESSENGER_FORM_ACTION_ORIGINS = ['https://t.me'];

/** A fresh script nonce: 128 random bits in base64 (a valid CSP nonce-source). */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The policy for one response. `dev` (next dev) adds what React refresh needs: 'unsafe-eval'
 * for scripts and the HMR socket.
 */
export function contentSecurityPolicy(nonce: string, { dev = false }: { dev?: boolean } = {}) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${[...PAYMENT_FORM_ACTION_ORIGINS, ...MESSENGER_FORM_ACTION_ORIGINS].join(' ')}`,
    "frame-ancestors 'none'",
  ].join('; ');
}
