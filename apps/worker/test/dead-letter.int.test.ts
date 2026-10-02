// Dead-letter (decision Б30) and alerts (decision Б19) on the real Redis 7 and PostgreSQL 16:
// UnrecoverableError and exhausted attempts park the job in `dead-letter` with a PD-free error
// and alert the sellers; «Повторить» puts it back with its original id; a Rossko rate limit
// delays a job without spending attempts. Alerts write a notifications row before sending and
// fall back from the owner's private chat to the sellers chat.
import { randomUUID } from 'node:crypto';
import { createLogger, createWorkerRedis, parseEnv, QUEUE, type Redis } from '@detaly/config';
import { minimalEnvSource, testRedisUrl } from '@detaly/config/testing';
import { createDb, eq, notifications, staff, type Db } from '@detaly/db';
import { RosskoRateLimitError } from '@detaly/rossko';
import { UnrecoverableError, type Job, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { alertDedupeKey, createAlerts } from '../src/alerts';
import { DEAD_LETTER_JOB, type DeadLetterData } from '../src/dead-letter';
import type { JobProcessor } from '../src/deps';
import { createQueueInspector } from '../src/inspector';
import { createWorkers } from '../src/workers';
import { hasTestDatabase, prepareOwnDatabase } from './fixtures/databases';
import { fakeTelegram } from './fixtures/telegram';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const logger = createLogger('worker-test', { level: 'silent' });
const SELLER_CHAT_ID = -100_555_000;

let databaseUrl: string;
let db: Db;

describe.skipIf(!hasTestDatabase)('dead-letter', () => {
  let t: TestDeps;
  let workerRedis: Redis;
  let workers: Worker[] = [];
  let parked: (string | null)[];
  const behaviour: Record<string, JobProcessor> = {};

  beforeAll(async () => {
    const url = await prepareOwnDatabase('dlq');
    if (!url) throw new Error('DATABASE_URL_TEST is not set');
    databaseUrl = url;
    db = createDb(databaseUrl, { max: 4 });
    t = await createTestDeps({
      db,
      env: parseEnv(minimalEnvSource({ DATABASE_URL: databaseUrl, REDIS_URL: testRedisUrl() })),
    });
    workerRedis = createWorkerRedis(testRedisUrl());
    parked = [];
    // Each test sets the behaviour of the processor of the job name it adds.
    const dispatch: JobProcessor = async (job, deps) => {
      const run = behaviour[job.name];
      if (!run) throw new Error(`no behaviour for ${job.name}`);
      return run(job, deps);
    };
    workers = createWorkers({
      connection: workerRedis,
      logger,
      deps: t.deps,
      processors: { notify: dispatch, receipts: dispatch, rossko: dispatch, payments: dispatch },
      onDeadLetter: (id) => parked.push(id),
    });
  });

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
    await t.close();
    await workerRedis.quit();
  });

  afterEach(() => {
    t.fakes.alerts.calls.length = 0;
    parked.length = 0;
  });

  async function parkedEntry(id: string): Promise<Job<DeadLetterData> | undefined> {
    return (await t.deps.queues[QUEUE.deadLetter].getJob(id)) as Job<DeadLetterData> | undefined;
  }

  it('parks an UnrecoverableError at once, without PD, and alerts the sellers', async () => {
    let runs = 0;
    behaviour['order'] = async () => {
      runs += 1;
      throw new UnrecoverableError(
        'gateway refused +7 (912) 345-67-89 token AbCdEfGhIjKlMnOpQrStUv12',
      );
    };
    const id = `notify|${randomUUID()}|arrived`;
    await t.deps.queues.notify.add('order', { orderEventId: 'e1' }, { jobId: id, attempts: 5 });

    await vi.waitFor(() => expect(parked).toHaveLength(1), { timeout: 10_000, interval: 50 });
    expect(runs).toBe(1);
    expect(parked[0]).toBe(`notify|${id}`);

    const entry = await parkedEntry(`notify|${id}`);
    expect(entry?.name).toBe(DEAD_LETTER_JOB);
    expect(entry?.data).toMatchObject({
      queue: 'notify',
      name: 'order',
      jobId: id,
      data: { orderEventId: 'e1' },
      attemptsMade: 1,
    });
    expect(entry?.data.error).toContain('[phone]');
    expect(entry?.data.error).toContain('[redacted]');
    expect(entry?.data.error).not.toMatch(/912|AbCdEf/);

    expect(t.fakes.alerts.calls).toHaveLength(1);
    const alert = t.fakes.alerts.calls[0];
    expect(alert?.audience).toBe('sellers');
    expect(alert?.text).toContain('notify / order');
    expect(alert?.text).toContain('/queues');
    expect(alert?.text).not.toMatch(/912|AbCdEf/);
    expect(alert?.dedupeKey).toMatch(
      new RegExp(`^dead-letter:notify\\|${id.replaceAll('|', '\\|')}:\\d+$`),
    );
  });

  it('parks a job only after its last attempt', async () => {
    let runs = 0;
    behaviour['offset'] = async () => {
      runs += 1;
      throw new Error('receipt provider unavailable');
    };
    const id = `receipt|${randomUUID()}`;
    await t.deps.queues.receipts.add(
      'offset',
      { receiptId: 'r1' },
      {
        jobId: id,
        attempts: 3,
        backoff: { type: 'fixed', delay: 10 },
      },
    );

    await vi.waitFor(() => expect(parked).toHaveLength(1), { timeout: 10_000, interval: 50 });
    expect(runs).toBe(3);
    expect((await parkedEntry(`receipts|${id}`))?.data).toMatchObject({
      queue: 'receipts',
      attemptsMade: 3,
      error: 'receipt provider unavailable',
    });
    expect(t.fakes.alerts.calls).toHaveLength(1);
  });

  it('«Повторить» puts the job back into its queue with the original id', async () => {
    let fail = true;
    let done = 0;
    behaviour['refund-create'] = async () => {
      if (fail) throw new UnrecoverableError('refund rejected');
      done += 1;
      return { ok: true };
    };
    const id = `refund-create|${randomUUID()}`;
    await t.deps.queues.payments.add('refund-create', { refundId: 'f1' }, { jobId: id });
    await vi.waitFor(() => expect(parked).toHaveLength(1), { timeout: 10_000, interval: 50 });
    const deadId = `payments|${id}`;

    const inspector = createQueueInspector({ queues: t.deps.queues });
    const listed = await inspector.deadLetters(10);
    expect(listed[0]).toMatchObject({
      id: deadId,
      queue: 'payments',
      name: 'refund-create',
      jobId: id,
      error: 'UnrecoverableError: refund rejected',
    });
    const stats = await inspector.stats();
    expect(stats.map((s) => s.queue)).toContain('dead-letter');
    expect(stats.find((s) => s.queue === 'payments')?.failed).toBeGreaterThanOrEqual(1);
    expect(stats.find((s) => s.queue === 'dead-letter')?.waiting).toBeGreaterThanOrEqual(1);

    fail = false;
    expect(await inspector.retryDeadLetter(deadId)).toBe(true);
    await vi.waitFor(() => expect(done).toBe(1), { timeout: 10_000, interval: 50 });
    const job = await t.deps.queues.payments.getJob(id);
    expect(job?.data).toEqual({ refundId: 'f1' });
    expect(await job?.getState()).toBe('completed');
    expect(await parkedEntry(deadId)).toBeUndefined();
    expect((await inspector.deadLetters(50)).map((d) => d.id)).not.toContain(deadId);

    expect(await inspector.retryDeadLetter(deadId)).toBe(false);
    expect(await inspector.retryDeadLetter('payments|missing')).toBe(false);
  });

  it('delays a job on RosskoRateLimitError instead of spending an attempt', async () => {
    let runs = 0;
    behaviour['recheck'] = async () => {
      runs += 1;
      if (runs === 1) throw new RosskoRateLimitError(300);
      return { ok: true };
    };
    const id = `recheck|${randomUUID()}`;
    await t.deps.queues.rossko.add('recheck', { orderId: 'o1' }, { jobId: id, attempts: 1 });
    await vi.waitFor(
      async () =>
        expect(await (await t.deps.queues.rossko.getJob(id))?.getState()).toBe('completed'),
      { timeout: 10_000, interval: 50 },
    );
    expect(runs).toBe(2);
    expect(parked).toHaveLength(0);
  });
});

describe.skipIf(!hasTestDatabase)('alerts', () => {
  const owner = { id: '', tgUserId: 0 };

  beforeAll(async () => {
    // The `dlq` database is prepared by the suite above (files run their suites in order).
    db ??= createDb(databaseUrl, { max: 4 });
    owner.tgUserId = 700_000_000 + Math.floor(Math.random() * 1_000_000);
    const [row] = await db
      .insert(staff)
      .values({ name: 'Владелец', role: 'owner', tgUserId: owner.tgUserId })
      .returning({ id: staff.id });
    owner.id = row!.id;
  });

  afterAll(async () => {
    await db.close();
  });

  async function stored(key: string) {
    const [row] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.dedupeKey, alertDedupeKey(key)));
    return row;
  }

  it('sends to the sellers chat once per dedupe key', async () => {
    const tg = fakeTelegram();
    const alerts = createAlerts({ db, telegram: tg.api, sellerChatId: SELLER_CHAT_ID, logger });
    const key = `test:${randomUUID()}`;
    await alerts.send({ audience: 'sellers', text: 'Чек не прошёл: DT-000123', dedupeKey: key });
    await alerts.send({ audience: 'sellers', text: 'Чек не прошёл: DT-000123', dedupeKey: key });

    expect(tg.messages()).toEqual([
      { chatId: String(SELLER_CHAT_ID), text: 'Чек не прошёл: DT-000123' },
    ]);
    expect(await stored(key)).toMatchObject({
      chatId: String(SELLER_CHAT_ID),
      staffId: null,
      channel: 'telegram',
      template: 'alert',
      status: 'sent',
      attempts: 1,
    });
  });

  it("sends owner alerts to the owner's private chat", async () => {
    const tg = fakeTelegram();
    const alerts = createAlerts({ db, telegram: tg.api, sellerChatId: SELLER_CHAT_ID, logger });
    const key = `test:${randomUUID()}`;
    await alerts.send({ audience: 'owner', text: 'Сумма не совпала', dedupeKey: key });
    expect(tg.messages().map((m) => m.chatId)).toEqual([String(owner.tgUserId)]);
    expect(await stored(key)).toMatchObject({
      chatId: String(owner.tgUserId),
      staffId: owner.id,
      status: 'sent',
      fallbackReason: null,
    });
  });

  it('falls back to the sellers chat when the owner never started the bot (403)', async () => {
    const tg = fakeTelegram({
      fail: (call) =>
        call.payload.chat_id === String(owner.tgUserId)
          ? {
              error_code: 403,
              description: "Forbidden: bot can't initiate conversation with a user",
            }
          : null,
    });
    const alerts = createAlerts({ db, telegram: tg.api, sellerChatId: SELLER_CHAT_ID, logger });
    const key = `test:${randomUUID()}`;
    await alerts.send({ audience: 'owner', text: 'Возврат не прошёл', dedupeKey: key });
    expect(tg.calls.map((c) => String(c.payload.chat_id))).toEqual([
      String(owner.tgUserId),
      String(SELLER_CHAT_ID),
    ]);
    expect(await stored(key)).toMatchObject({
      chatId: String(SELLER_CHAT_ID),
      staffId: null,
      status: 'sent',
      fallbackReason: 'owner_chat_unreachable',
    });
  });

  it('records a failure without the token and sends on the next try', async () => {
    let down = true;
    const tg = fakeTelegram({
      fail: () => (down ? { error_code: 502, description: 'Bad Gateway' } : null),
    });
    const alerts = createAlerts({ db, telegram: tg.api, sellerChatId: SELLER_CHAT_ID, logger });
    const key = `test:${randomUUID()}`;
    await expect(
      alerts.send({ audience: 'sellers', text: 'Задача не выполнена', dedupeKey: key }),
    ).rejects.toThrow(/alert failed/);
    const failed = await stored(key);
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed?.error).not.toContain('test-token');

    down = false;
    await alerts.send({ audience: 'sellers', text: 'Задача не выполнена', dedupeKey: key });
    expect(await stored(key)).toMatchObject({ status: 'sent', attempts: 2, error: null });
  });

  it('is skipped without a bot token and silent without any chat', async () => {
    const alerts = createAlerts({ db, telegram: null, sellerChatId: SELLER_CHAT_ID, logger });
    const key = `test:${randomUUID()}`;
    await alerts.send({ audience: 'sellers', text: 'Бюджет SMS 80%', dedupeKey: key });
    expect(await stored(key)).toMatchObject({
      status: 'skipped',
      fallbackReason: 'driver_unavailable',
    });

    const tg = fakeTelegram();
    const noChat = createAlerts({ db, telegram: tg.api, sellerChatId: undefined, logger });
    const other = `test:${randomUUID()}`;
    await noChat.send({ audience: 'sellers', text: 'Бюджет SMS 80%', dedupeKey: other });
    expect(tg.calls).toHaveLength(0);
    expect(await stored(other)).toBeUndefined();
  });
});
