/**
 * POST /api/webhooks/yookassa (docs/phase-1b-implementation.md 14.3, decisions Б1, Б4).
 *
 * 1. Sender: the address only from X-Real-IP (set by Caddy) and only with
 *    TRUSTED_IP_HEADER=x-real-ip; it must be in YOOKASSA_WEBHOOK_IP_ALLOWLIST. Anything else,
 *    an empty allowlist or an invalid one included, is 403 (fail closed).
 * 2. Body: at most 64 KB (413), a YooKassa notification (parseYooKassaWebhook) or 400.
 * 3. One transaction: webhook_events (`on conflict do nothing`, with the IP as received) and,
 *    only when the row is new, the outbox row payments/webhook keyed `${event}:${object.id}`
 *    (webhookJobId). Commit, nudge the worker, 200 at once. A repeated notification is 200
 *    without new rows.
 *
 * The notification is only a hint: the worker re-reads the payment or refund by id and trusts
 * that answer. Logs carry the event and the object id: never the body or the IP.
 */
import { PAYMENTS_JOBS, type Env, type Logger } from '@detaly/config';
import { webhookEvents, type Database } from '@detaly/db';
import { enqueueOutbox } from '@detaly/orders';
import {
  isAllowedWebhookIp,
  parseWebhookIpAllowlist,
  parseYooKassaWebhook,
  webhookJobId,
  type WebhookIpAllowlist,
  type WebhookNotification,
} from '@detaly/payments';
import { readBoundedText } from '../body';
import { errorInfo } from '../errors';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * Largest notification body (YooKassa objects are a few KB).
 * VERIFY: Ю5 — the largest notification YooKassa sends (payment objects with a receipt and
 * metadata stay far below 64 KB in the reference examples).
 */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export type WebhookEnv = Pick<Env, 'TRUSTED_IP_HEADER' | 'YOOKASSA_WEBHOOK_IP_ALLOWLIST'>;

export interface WebhookHandlerDeps {
  db: Database;
  env: WebhookEnv;
  /** Wakes the worker's outbox dispatcher after the commit. */
  nudge?: () => void;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

function json(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const parsedLists = new Map<string, WebhookIpAllowlist | null>();

/**
 * The parsed allowlist of an env value, cached per value. An invalid entry gives null (every
 * webhook is refused) and one error log line per distinct value.
 */
export function webhookAllowlist(
  list: readonly string[],
  logger?: Pick<Logger, 'error'>,
): WebhookIpAllowlist | null {
  const key = list.join(',');
  if (parsedLists.has(key)) return parsedLists.get(key) ?? null;
  let parsed: WebhookIpAllowlist | null;
  try {
    parsed = parseWebhookIpAllowlist(list);
  } catch (error) {
    logger?.error(
      { err: error instanceof Error ? error.name : 'error' },
      'YOOKASSA_WEBHOOK_IP_ALLOWLIST is invalid: every webhook is refused',
    );
    parsed = null;
  }
  parsedLists.set(key, parsed);
  return parsed;
}

/** Sender check of decision Б4; the address is returned for webhook_events.ip. */
export function webhookSender(
  headers: { get(name: string): string | null },
  env: WebhookEnv,
  logger?: Pick<Logger, 'error'>,
): { allowed: true; ip: string } | { allowed: false; reason: string } {
  if (env.TRUSTED_IP_HEADER !== 'x-real-ip') return { allowed: false, reason: 'untrusted_header' };
  const ip = headers.get('x-real-ip')?.trim() ?? '';
  if (ip === '') return { allowed: false, reason: 'no_ip' };
  const allowlist = webhookAllowlist(env.YOOKASSA_WEBHOOK_IP_ALLOWLIST, logger);
  if (allowlist === null || allowlist.size === 0) return { allowed: false, reason: 'no_allowlist' };
  if (!isAllowedWebhookIp(ip, allowlist)) return { allowed: false, reason: 'not_allowed' };
  return { allowed: true, ip };
}

async function readNotification(
  request: Request,
): Promise<
  { ok: true; notification: WebhookNotification; body: unknown } | { ok: false; status: 400 | 413 }
> {
  const text = await readBoundedText(request, MAX_WEBHOOK_BODY_BYTES);
  if (!text.ok) return { ok: false, status: 413 };
  let body: unknown;
  try {
    body = JSON.parse(text.text) as unknown;
  } catch {
    return { ok: false, status: 400 };
  }
  try {
    return { ok: true, notification: parseYooKassaWebhook(body), body };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** Stores a notification once and queues its job; false when it was stored before. */
export async function storeWebhook(
  db: Database,
  notification: WebhookNotification,
  body: unknown,
  ip: string | null,
): Promise<{ stored: boolean; webhookEventId: string | null }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(webhookEvents)
      .values({
        source: 'yookassa',
        externalId: notification.objectId,
        eventType: notification.event,
        payload: body as object,
        ip,
      })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (!row) return { stored: false, webhookEventId: null };
    await enqueueOutbox(tx, {
      queue: 'payments',
      name: PAYMENTS_JOBS.webhook,
      key: webhookJobId(notification),
      data: { webhookEventId: row.id },
    });
    return { stored: true, webhookEventId: row.id };
  });
}

export async function handleYooKassaWebhook(
  request: Request,
  deps: WebhookHandlerDeps,
): Promise<Response> {
  const { logger } = deps;
  const sender = webhookSender(request.headers, deps.env, logger);
  if (!sender.allowed) {
    logger?.warn({ reason: sender.reason }, 'yookassa webhook refused');
    return json({ error: 'forbidden' }, 403);
  }
  const read = await readNotification(request);
  if (!read.ok) {
    logger?.warn({ status: read.status }, 'yookassa webhook: bad body');
    return json({ error: read.status === 413 ? 'too_large' : 'bad_request' }, read.status);
  }
  const { notification, body } = read;
  const log = { event: notification.event, objectId: notification.objectId };
  try {
    const result = await storeWebhook(deps.db, notification, body, sender.ip);
    if (result.stored) {
      try {
        deps.nudge?.();
      } catch {
        // best effort (decision Б1): the dispatcher polls anyway
      }
    }
    logger?.info({ ...log, duplicate: !result.stored }, 'yookassa webhook');
    return json({}, 200);
  } catch (error) {
    // 500: YooKassa repeats the notification later. VERIFY: Ю5 — the retry schedule of
    // notifications (PLAN section 4: «срок ретраев»); reconciliation covers a lost one anyway.
    logger?.error({ ...log, ...errorInfo(error) }, 'yookassa webhook: store failed');
    return json({ error: 'internal' }, 500);
  }
}
