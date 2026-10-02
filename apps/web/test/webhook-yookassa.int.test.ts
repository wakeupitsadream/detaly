// POST /api/webhooks/yookassa (section 14.3, decision Б4) against local PG: the IP allowlist on
// X-Real-IP (fail closed), the body limit, webhook_events + one outbox row per notification,
// duplicates and the log contents. Notification bodies come from the msw emulation's
// `notification()` (the shape YooKassa posts).
import { randomBytes } from 'node:crypto';
import { createDb, eq, outbox, webhookEvents, type Db } from '@detaly/db';
import { webhookJobId } from '@detaly/payments';
import { createYooKassaMock, type YooKassaMock } from '@detaly/payments/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  handleYooKassaWebhook,
  MAX_WEBHOOK_BODY_BYTES,
  webhookSender,
  type WebhookEnv,
  type WebhookHandlerDeps,
} from '@/server/payments/webhook-handler';
import { webDatabaseUrl } from './helpers';

const ALLOWLIST = ['185.71.76.0/27', '77.75.156.11', '2a02:5180::/32'];
const ENV: WebhookEnv = {
  TRUSTED_IP_HEADER: 'x-real-ip',
  YOOKASSA_WEBHOOK_IP_ALLOWLIST: ALLOWLIST,
};

let db: Db;
let mock: YooKassaMock;
let nudges = 0;
let logs: { level: string; details: unknown; message: string }[] = [];

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 4 });
  mock = createYooKassaMock({ shopId: 'test-shop', secretKey: 'test-secret' });
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  nudges = 0;
  logs = [];
});

const logger = {
  info: (details: unknown, message: string) => logs.push({ level: 'info', details, message }),
  warn: (details: unknown, message: string) => logs.push({ level: 'warn', details, message }),
  error: (details: unknown, message: string) => logs.push({ level: 'error', details, message }),
} as unknown as NonNullable<WebhookHandlerDeps['logger']>;

function deps(env: WebhookEnv = ENV): WebhookHandlerDeps {
  return {
    db,
    env,
    nudge: () => {
      nudges += 1;
    },
    logger,
  };
}

/** A notification body for a fresh payment id (no payment needs to exist: it is a hint). */
function notification(event = 'payment.succeeded', id = `2${randomBytes(8).toString('hex')}`) {
  const body = mock.notification(event, id) as Record<string, unknown>;
  return { id, body };
}

async function post(
  body: unknown,
  { ip = '185.71.76.10', env = ENV }: { ip?: string | null; env?: WebhookEnv } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ip !== null) headers['X-Real-IP'] = ip;
  const response = await handleYooKassaWebhook(
    new Request('http://127.0.0.1:3100/api/webhooks/yookassa', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    deps(env),
  );
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function stored(objectId: string) {
  return db.select().from(webhookEvents).where(eq(webhookEvents.externalId, objectId));
}

describe('POST /api/webhooks/yookassa', () => {
  it('stores the notification with its IP and one outbox job, nudges, answers 200', async () => {
    const { id, body } = notification();
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const rows = await stored(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'yookassa',
      eventType: 'payment.succeeded',
      ip: '185.71.76.10',
      processedAt: null,
    });
    expect(rows[0]?.payload).toEqual(body);
    const key = webhookJobId({ event: 'payment.succeeded', objectId: id });
    expect(key).toBe(`payment.succeeded:${id}`);
    const jobs = await db.select().from(outbox).where(eq(outbox.jobId, key));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      queue: 'payments',
      name: 'webhook',
      data: { webhookEventId: rows[0]?.id },
      dispatchedAt: null,
    });
    expect(nudges).toBe(1);
    expect(logs.find((l) => l.message === 'yookassa webhook')?.details).toEqual({
      event: 'payment.succeeded',
      objectId: id,
      duplicate: false,
    });
  });

  it('a repeated notification: 200, no new row, no new outbox job, no nudge', async () => {
    const { id, body } = notification('refund.succeeded');
    expect((await post(body)).status).toBe(200);
    expect((await post(body, { ip: '77.75.156.11' })).status).toBe(200);
    expect(await stored(id)).toHaveLength(1);
    const jobs = await db
      .select()
      .from(outbox)
      .where(eq(outbox.jobId, `refund.succeeded:${id}`));
    expect(jobs).toHaveLength(1);
    expect(nudges).toBe(1);
    expect(logs.at(-1)?.details).toMatchObject({ duplicate: true });
  });

  it('another event of the same object is a separate notification', async () => {
    const { id, body } = notification('payment.waiting_for_capture');
    await post(body);
    await post(mock.notification('payment.canceled', id));
    expect((await stored(id)).map((r) => r.eventType).sort()).toEqual([
      'payment.canceled',
      'payment.waiting_for_capture',
    ]);
  });

  it('403 from an address outside the allowlist, without X-Real-IP, or with a junk address', async () => {
    const { id, body } = notification();
    expect((await post(body, { ip: '203.0.113.9' })).status).toBe(403);
    expect((await post(body, { ip: null })).status).toBe(403);
    expect((await post(body, { ip: 'not-an-ip' })).status).toBe(403);
    expect((await post(body, { ip: '185.71.76.32' })).status).toBe(403);
    expect(await stored(id)).toHaveLength(0);
    expect(nudges).toBe(0);
    // The refused sender's address is not logged.
    expect(JSON.stringify(logs)).not.toContain('203.0.113.9');
  });

  it('allowlisted IPv6 and IPv4-mapped addresses pass', async () => {
    const a = notification();
    expect((await post(a.body, { ip: '2a02:5180:0:1::5' })).status).toBe(200);
    const b = notification();
    expect((await post(b.body, { ip: '::ffff:185.71.76.1' })).status).toBe(200);
  });

  it('fail closed: TRUSTED_IP_HEADER=none, an empty or an invalid allowlist refuse everything', async () => {
    const { id, body } = notification();
    expect((await post(body, { env: { ...ENV, TRUSTED_IP_HEADER: 'none' } })).status).toBe(403);
    expect((await post(body, { env: { ...ENV, YOOKASSA_WEBHOOK_IP_ALLOWLIST: [] } })).status).toBe(
      403,
    );
    const invalid = { ...ENV, YOOKASSA_WEBHOOK_IP_ALLOWLIST: ['185.71.76.0/99'] };
    expect((await post(body, { env: invalid })).status).toBe(403);
    expect(await stored(id)).toHaveLength(0);
    expect(webhookSender({ get: () => '185.71.76.10' }, invalid)).toEqual({
      allowed: false,
      reason: 'no_allowlist',
    });
  });

  it('400 for junk and non-notifications, 413 above 64 KB; nothing stored', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect(
      (await post({ type: 'notification', event: 'payment.succeeded', object: {} })).status,
    ).toBe(400);
    expect(
      (await post({ type: 'notification', event: 'deal.closed', object: { id: 'x' } })).status,
    ).toBe(400);
    const { id, body } = notification();
    const big = { ...body, padding: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES) };
    expect((await post(big)).status).toBe(413);
    expect(await stored(id)).toHaveLength(0);
  });

  it('logs the event and the object id only: no body, no metadata, no IP', async () => {
    const { body } = notification();
    const object = body.object as Record<string, unknown>;
    object.metadata = { order_id: 'secret-order-id', order_number: 'DT-424242' };
    await post(body);
    const text = JSON.stringify(logs);
    expect(text).not.toContain('secret-order-id');
    expect(text).not.toContain('DT-424242');
    expect(text).not.toContain('185.71.76.10');
  });

  it('the route module is dynamic and exports POST only', async () => {
    const route = await import('@/app/api/webhooks/yookassa/route');
    expect(typeof route.POST).toBe('function');
    expect(route.dynamic).toBe('force-dynamic');
    expect(Object.keys(route).sort()).toEqual(['POST', 'dynamic']);
  });
});
