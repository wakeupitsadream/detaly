/**
 * Small HTTP helpers of the VIN form and the proposal API (phase 1C): plain forms work without
 * JavaScript, so a refusal is a short HTML page or a 303 back; the /vin form with JavaScript asks
 * for JSON (`Accept: application/json`). Nothing here echoes a field value or a token.
 */

const NO_STORE = 'no-store';

/** The request asks for JSON (the /vin form submitted by fetch). */
export function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').toLowerCase().includes('application/json');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 303 to a same-site path, optionally setting cookies. */
export function seeOther(location: string, setCookies: readonly string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': NO_STORE });
  for (const cookie of setCookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': NO_STORE } });
}

/**
 * A short HTML page for a refused form post (the site layout is not rendered for API routes).
 * `back` is a same-site link with its label.
 */
export function messagePage(
  status: number,
  title: string,
  message: string,
  back: { href: string; label: string },
): Response {
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;margin:0;padding:48px 16px;color:#1c1917;background:#fafaf9}main{max-width:36rem;margin:0 auto}h1{font-size:1.5rem}a{color:#b45309}</style>
</head><body><main>
<h1>${escapeHtml(title)}</h1>
<p data-testid="form-error">${escapeHtml(message)}</p>
<p><a href="${escapeHtml(back.href)}">${escapeHtml(back.label)}</a></p>
</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': NO_STORE,
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
