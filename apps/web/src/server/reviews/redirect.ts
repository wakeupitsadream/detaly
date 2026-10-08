/**
 * GET /o/<token>/review/<platform> (step 3, docs/reviews.md): the review buttons of the messages
 * («Как деталь?», the reminder) and of the order page card lead here, not to the map service, so
 * the shop knows a link was opened. The first open per platform and order is journaled
 * (order_events `review_link_opened`, actor client, payload {platform}; no status change), then
 * 302 to REVIEW_URL_<platform>.
 *
 * - The destination is only ever the configured link (never taken from the request: no open
 *   redirect). Unknown platform, a platform without its link, a malformed or unknown token: 404.
 * - Only a GET that is a navigation counts: HEAD, prefetches and subresource requests (an <img>, a
 *   fetch) are answered the same way without journaling. A navigation from outside the site (the
 *   messenger, a QR) counts: the buttons are opened from there.
 * - Referrer-Policy no-referrer (the token must not reach the map service), Cache-Control
 *   no-store, X-Robots-Tag noindex on every answer (src/proxy.ts sets them for /o/* as well).
 *   Nothing with personal data or the token is logged.
 * - DEMO_MODE (no database): the sample order /o/demo redirects without journaling, every other
 *   token is a 404.
 */
import { reviewUrls, type Env } from '@detaly/config';
import { and, eq, orderEvents, orders, sql, type Database } from '@detaly/db';
import { isOneOf, REVIEW_PLATFORMS, type JournalEvent, type ReviewPlatform } from '@detaly/domain';
import { recordJournalEvent } from '@detaly/orders';
import { errorInfo } from '../errors';
import { isOrderToken } from '../orders/access';

/** The sample order of DEMO_MODE (app/(site)/o/demo). */
export const DEMO_REVIEW_TOKEN = 'demo';

const LINK_OPENED: JournalEvent = 'review_link_opened';

export const REVIEW_REDIRECT_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
} as const;

/** The 404 of the redirect: a whole page that reads without scripts, like the site's 404. */
const NOT_FOUND_HTML = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Страница не найдена</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;margin:0;padding:64px 16px;color:#111317;background:#fff}main{max-width:36rem;margin:0 auto;padding:32px 24px;border-radius:28px;background:#f2f3f5}p{font-size:17px;line-height:26px}.eyebrow{margin:0;font-size:15px;color:#5b616b}h1{margin:8px 0 12px;font-size:28px;line-height:34px}a{display:inline-block;min-height:44px;line-height:44px;font-weight:600;color:#111317}</style>
</head><body><main>
<p class="eyebrow">Ошибка 404</p>
<h1>Страница не найдена</h1>
<p>Ссылка устарела или в адресе опечатка. Ссылку на отзыв мы присылаем в сообщении о заказе.</p>
<p><a href="/">На главную</a></p>
</main></body></html>`;

export function reviewNotFound(): Response {
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: { ...REVIEW_REDIRECT_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function reviewRedirect(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: { ...REVIEW_REDIRECT_HEADERS, Location: url },
  });
}

interface HeaderSource {
  get(name: string): string | null;
}

/**
 * A GET navigation: not HEAD, not a prefetch (Purpose / Sec-Purpose, Next's router prefetch),
 * not a subresource (Sec-Fetch-Dest / Sec-Fetch-Mode when the browser sends them).
 */
export function countsAsOpen(method: string, headers: HeaderSource): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  const purpose = `${headers.get('sec-purpose') ?? ''} ${headers.get('purpose') ?? ''}`;
  if (/prefetch|prerender/i.test(purpose)) return false;
  if (headers.get('next-router-prefetch') !== null) return false;
  const dest = headers.get('sec-fetch-dest');
  if (dest !== null && dest.toLowerCase() !== 'document') return false;
  const mode = headers.get('sec-fetch-mode');
  if (mode !== null && mode.toLowerCase() !== 'navigate') return false;
  return true;
}

export type ReviewOpenOutcome = 'recorded' | 'seen' | 'missing';

/**
 * Finds the order of `token` and, with `count`, journals the first open of `platform` under the
 * order row lock (recordJournalEvent expects it): a second open of the same platform, or two
 * at once, write one row. 'missing': no such order.
 */
export async function recordReviewOpen(
  db: Database,
  input: { token: string; platform: ReviewPlatform; at: Date; count: boolean },
): Promise<ReviewOpenOutcome> {
  if (!input.count) {
    const [order] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.accessToken, input.token));
    return order ? 'seen' : 'missing';
  }
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select({ id: orders.id, userId: orders.userId })
      .from(orders)
      .where(eq(orders.accessToken, input.token))
      .for('update');
    if (!order) return 'missing';
    const [seen] = await tx
      .select({ id: orderEvents.id })
      .from(orderEvents)
      .where(
        and(
          eq(orderEvents.orderId, order.id),
          eq(orderEvents.type, LINK_OPENED),
          sql`${orderEvents.payload}->>'platform' = ${input.platform}`,
        ),
      )
      .limit(1);
    if (seen) return 'seen';
    await recordJournalEvent(tx, {
      orderId: order.id,
      type: LINK_OPENED,
      actor: { type: 'client', id: order.userId },
      payload: { platform: input.platform },
      at: input.at,
    });
    return 'recorded';
  });
}

export interface ReviewRedirectDeps {
  env: Pick<Env, 'DEMO_MODE' | 'REVIEW_URL_YANDEX' | 'REVIEW_URL_2GIS'>;
  /** null in DEMO_MODE. */
  db: Database | null;
  now?: () => Date;
  logger?: { warn(details: Record<string, unknown>, message: string): void };
}

export async function handleReviewRedirect(
  request: Request,
  params: { token: string; platform: string },
  deps: ReviewRedirectDeps,
): Promise<Response> {
  const { token, platform } = params;
  if (!isOneOf(REVIEW_PLATFORMS, platform)) return reviewNotFound();
  const url = reviewUrls(deps.env)[platform];
  if (url === null) return reviewNotFound();
  if (deps.env.DEMO_MODE) {
    return token === DEMO_REVIEW_TOKEN ? reviewRedirect(url) : reviewNotFound();
  }
  if (!isOrderToken(token) || deps.db === null) return reviewNotFound();
  try {
    const outcome = await recordReviewOpen(deps.db, {
      token,
      platform,
      at: (deps.now ?? (() => new Date()))(),
      count: countsAsOpen(request.method, request.headers),
    });
    if (outcome === 'missing') return reviewNotFound();
  } catch (error) {
    // The review matters more than the counter: a database failure still sends the client on.
    // Names and SQLSTATE only (a driver message would carry the token).
    deps.logger?.warn({ ...errorInfo(error), platform }, 'review link: open not recorded');
  }
  return reviewRedirect(url);
}
