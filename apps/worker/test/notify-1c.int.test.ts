// Phase 1C client notifications on the `_worker` database (docs/phase-1c-implementation.md
// section 7.2 item 4, PLAN Verification 1C rows V2, V3, V5, V6): the client bot's Telegram
// (fake transport of test-deps: records sendMessage / sendPhoto, answers 403 / 429 on demand),
// SMS by the allowlist on a fake SMS Aero gateway, notify/vin for the client and the sellers card.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  asc,
  carts,
  claims,
  eq,
  installBookings,
  messengerBindings,
  notifications,
  orderEvents,
  orderItems,
  orderPhotos,
  orders,
  sql,
  users,
  vinRequests,
  type Db,
} from '@detaly/db';
import type { OrderStatus, PaymentScheme, VinRequestStatus } from '@detaly/domain';
import { createSmsDriver, TelegramRateLimitError, vinRequestNumber } from '@detaly/notify';
import type { Job } from 'bullmq';
import { InputFile } from 'grammy';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { processNotify } from '../src/jobs/notify';
import { createTestDeps, type TestDeps } from './helpers/test-deps';

const DAY = 86_400_000;

const ENV = {
  APP_BASE_URL: 'https://detaly.test',
  SMS_PROVIDER: 'smsaero',
  PICKUP_POINT_NAME: 'Пункт выдачи',
  PICKUP_ADDRESS: 'ул. Тестовая, 1',
  PICKUP_HOURS: 'Пн-Сб 9:00-19:00',
  INSTALL_PARTNER_NAME: 'Тестовый сервис',
  INSTALL_PARTNER_REQUISITES: 'ИП Сервисов С. С., ИНН 560011122233',
};

/** The SMS Aero gateway on a fake fetch: records the requests. */
function fakeGateway() {
  const gateway = {
    calls: [] as URL[],
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      gateway.calls.push(url);
      return new Response(
        JSON.stringify({ success: true, data: { id: gateway.calls.length, cost: '3.69' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  };
  return gateway;
}

function smsDriver(gateway: ReturnType<typeof fakeGateway>) {
  return createSmsDriver({
    provider: 'smsaero',
    login: 'shop@example.test',
    apiKey: 'test-key',
    sender: 'Shop',
    apiUrl: 'https://sms.test/v2',
    fetch: gateway.fetch,
  });
}

function job(name: 'order' | 'vin', data: Record<string, unknown>, attemptsMade = 0): Job {
  return { name, data, attemptsMade, opts: { attempts: 5 } } as unknown as Job;
}

function randomPhone(): string {
  return `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

async function seedOrder(
  db: Db,
  input: { status: OrderStatus; scheme?: PaymentScheme; phone?: string } = { status: 'ready' },
) {
  const phone = input.phone ?? randomPhone();
  const [user] = await db.insert(users).values({ phone, name: 'Иван Петров' }).returning();
  const [order] = await db
    .insert(orders)
    .values({
      userId: user!.id,
      accessToken: randomBytes(32).toString('base64url'),
      status: input.status,
      paymentScheme: input.scheme ?? 'prepay',
      subtotalKop: 128_000,
      totalKop: 128_000,
      itemsHash: 'test',
      pickupCode: '4821',
      promisedDate: '2026-10-08',
    })
    .returning();
  await db.insert(orderItems).values({
    orderId: order!.id,
    offerKey: 'W9142:MANN:ORB1',
    searchArticleNorm: 'W9142',
    brand: 'MANN',
    article: 'W 914/2',
    name: 'Фильтр масляный',
    qty: 1,
    stockId: 'ORB1',
    isLocal: true,
    priceSupplierAtOrderKop: 100_000,
    priceClientKop: 128_000,
    markupBp: 2800,
    etaDate: '2026-10-06',
    offerSnapshot: {
      source: 'rossko',
      brand: 'MANN',
      article: 'W 914/2',
      articleNorm: 'W9142',
      name: 'Фильтр масляный',
      group: null,
      isCross: false,
      priceSupplierKop: 100_000,
      stock: {
        stockId: 'ORB1',
        isLocal: true,
        count: 4,
        multiplicity: 1,
        type: null,
        deliveryDays: 2,
        deliveryStart: null,
        deliveryEnd: null,
        extra: null,
        description: null,
      },
    },
    state: 'arrived',
  });
  return {
    orderId: order!.id,
    number: order!.number,
    token: order!.accessToken,
    userId: user!.id,
    phone,
  };
}

async function bindTelegram(db: Db, userId: string, chatId = String(randomInt(1e8, 9e8))) {
  await db.insert(messengerBindings).values({
    userId,
    channel: 'telegram',
    externalUserId: chatId,
    chatId,
    isPrimary: true,
    phoneConfirmedAt: new Date(),
  });
  return chatId;
}

/** A journal event to hang a notification on (the engine and reminders do the same). */
async function journalEvent(db: Db, orderId: string, payload: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(orderEvents)
    .values({ orderId, type: 'reminder', actorType: 'system', payload })
    .returning({ id: orderEvents.id });
  return row!.id;
}

async function notificationRows(db: Db, prefix: string) {
  return db
    .select()
    .from(notifications)
    .where(sql`starts_with(${notifications.dedupeKey}, ${prefix})`)
    .orderBy(asc(notifications.createdAt));
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0xff, 0xd9]);

async function addPackagingPhoto(t: TestDeps, orderId: string): Promise<string> {
  const key = `order/${orderId}/${randomUUID()}.jpg`;
  await t.deps.files.put(key, JPEG);
  await t.deps.db.insert(orderPhotos).values({ orderId, kind: 'packaging', s3Key: key });
  return key;
}

const VIN = 'XTA21099012345678';

async function seedVinRequest(
  db: Db,
  input: { status?: VinRequestStatus; withProposal?: boolean; phone?: string } = {},
) {
  const phone = input.phone ?? randomPhone();
  const [user] = await db.insert(users).values({ phone }).returning();
  const [request] = await db
    .insert(vinRequests)
    .values({
      userId: user!.id,
      phone,
      vin: VIN,
      needText: `Фильтр масляный, мой номер ${phone}`,
      status: input.status ?? 'new',
      channel: 'sms',
      photos: [],
    })
    .returning();
  let token: string | null = null;
  if (input.withProposal) {
    token = randomBytes(24).toString('base64url');
    const [cart] = await db
      .insert(carts)
      .values({
        proposalToken: token,
        proposalExpiresAt: new Date(Date.now() + 7 * DAY),
        sellerNote: `Берите MANN, звоните ${phone}`,
        vinRequestId: request!.id,
      })
      .returning();
    await db
      .update(vinRequests)
      .set({ proposalCartId: cart!.id, proposalCount: 1, status: input.status ?? 'offered' })
      .where(eq(vinRequests.id, request!.id));
  }
  return { id: request!.id, userId: user!.id, phone, token };
}

/** No 7-digit run of the phone and no name in a text the client or Telegram gets. */
function expectNoPd(text: string, phone: string): void {
  const digits = phone.replace(/\D/g, '');
  const plain = text.replace(/\D/g, '');
  for (let i = 0; i + 7 <= digits.length; i += 1) {
    expect(plain, text).not.toContain(digits.slice(i, i + 7));
  }
  expect(text).not.toContain('Иван');
  expect(text).not.toContain(VIN);
}

describe.skipIf(!inject('workerDatabaseUrl'))('notify 1C: client bot, SMS, VIN', () => {
  const gateway = fakeGateway();
  let t: TestDeps;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDeps({ envOverrides: ENV, smsDriver: smsDriver(gateway) });
    db = t.deps.db;
  });
  afterAll(async () => {
    await t?.close();
  });

  const telegram = () => t.fakes.clientTelegram;

  it('a bound client gets paid, ordered and arrived in Telegram; no SMS', async () => {
    const order = await seedOrder(db, { status: 'ready' });
    const chatId = await bindTelegram(db, order.userId);
    const smsBefore = gateway.calls.length;
    const sentBefore = telegram().sent().length;
    for (const template of ['paid', 'ordered', 'arrived'] as const) {
      const orderEventId = await journalEvent(db, order.orderId);
      const result = await processNotify(
        job('order', { orderEventId, audience: 'client', template }),
        t.deps,
      );
      expect(result, template).toEqual({ status: 'sent', channel: 'telegram' });
      const [row] = await notificationRows(db, `${orderEventId}:${template}:`);
      expect(row).toMatchObject({
        dedupeKey: `${orderEventId}:${template}:telegram`,
        status: 'sent',
        channel: 'telegram',
        fallbackReason: null,
        attempts: 1,
      });
    }
    expect(gateway.calls.length).toBe(smsBefore);
    const sent = telegram().sent().slice(sentBefore);
    expect(sent.map((s) => [s.method, s.chatId])).toEqual([
      ['sendMessage', chatId],
      ['sendMessage', chatId],
      ['sendMessage', chatId],
    ]);
    for (const message of sent) {
      expect(message.text).toContain(order.number);
      expectNoPd(message.text ?? '', order.phone);
    }
    // No packaging photo: arrived is a plain message with the booking button.
    expect(sent[2]?.text).toContain('Код выдачи: 4821');
  });

  it('V5: arrived with a packaging photo goes by sendPhoto with the code and «Записаться»', async () => {
    const order = await seedOrder(db, { status: 'ready' });
    const chatId = await bindTelegram(db, order.userId);
    await addPackagingPhoto(t, order.orderId);
    const orderEventId = await journalEvent(db, order.orderId);
    const before = telegram().calls.length;
    expect(
      await processNotify(
        job('order', { orderEventId, audience: 'client', template: 'arrived' }),
        t.deps,
      ),
    ).toEqual({ status: 'sent', channel: 'telegram' });
    const calls = telegram().calls.slice(before);
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
    const payload = calls[0]!.payload as {
      chat_id: string;
      photo: unknown;
      caption: string;
      reply_markup: { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] };
    };
    expect(payload.chat_id).toBe(chatId);
    expect(payload.photo).toBeInstanceOf(InputFile);
    expect(payload.caption).toContain('Код выдачи: 4821');
    expect(payload.caption).toContain('Пункт выдачи, ул. Тестовая, 1.');
    expect(payload.caption).toContain('Тестовый сервис');
    expectNoPd(payload.caption, order.phone);
    const [install, link] = payload.reply_markup.inline_keyboard;
    expect(install?.[0]?.text).toBe('Записаться на установку');
    expect(install?.[0]?.callback_data).toMatch(
      new RegExp(`^a:install:${order.orderId}:[A-Za-z0-9_-]{8}$`),
    );
    expect(link?.[0]?.url).toBe(`https://detaly.test/o/${order.token}`);

    // Already booked (a later day-3 reminder): no second «Записаться».
    await db.insert(installBookings).values({
      orderId: order.orderId,
      userId: order.userId,
      slotAt: new Date(Date.now() + 2 * DAY),
      status: 'requested',
    });
    const again = await journalEvent(db, order.orderId);
    await processNotify(
      job('order', { orderEventId: again, audience: 'client', template: 'arrived', readyDays: 3 }),
      t.deps,
    );
    const last = telegram().calls.at(-1)!.payload as {
      caption: string;
      reply_markup: { inline_keyboard: unknown[][] };
    };
    expect(last.caption).toContain('Заказ ждёт вас 3 дн.');
    expect(last.reply_markup.inline_keyboard).toHaveLength(1);
  });

  it('V2: Telegram answers 403 -> blocked_at, arrived goes by SMS with blocked:telegram', async () => {
    const order = await seedOrder(db, { status: 'ready' });
    await bindTelegram(db, order.userId);
    const smsBefore = gateway.calls.length;
    telegram().failWith(403);
    try {
      const orderEventId = await journalEvent(db, order.orderId);
      expect(
        await processNotify(
          job('order', { orderEventId, audience: 'client', template: 'arrived' }),
          t.deps,
        ),
      ).toEqual({ status: 'sent', channel: 'sms' });
      const [row] = await notificationRows(db, `${orderEventId}:arrived:`);
      expect(row).toMatchObject({
        status: 'sent',
        channel: 'sms',
        fallbackReason: 'blocked:telegram',
      });
      expect(gateway.calls.length).toBe(smsBefore + 1);
      const sms = gateway.calls.at(-1)!;
      expect(sms.searchParams.get('number')).toBe(order.phone.slice(1));
      expect(sms.searchParams.get('text')).toBe(
        `Заказ ${order.number} приехал.\nКод выдачи 4821.\nhttps://detaly.test/o/${order.token}`,
      );
      const [binding] = await db
        .select()
        .from(messengerBindings)
        .where(eq(messengerBindings.userId, order.userId));
      expect(binding?.blockedAt).not.toBeNull();
    } finally {
      telegram().failWith(null);
    }

    // The next message does not try Telegram again; outside the allowlist it is skipped.
    const before = telegram().calls.length;
    const next = await journalEvent(db, order.orderId);
    expect(
      await processNotify(
        job('order', { orderEventId: next, audience: 'client', template: 'ordered' }),
        t.deps,
      ),
    ).toEqual({ status: 'skipped', fallbackReason: 'no_messenger:not_in_sms_allowlist' });
    expect(telegram().calls.length).toBe(before);
  });

  it('V3: ordered without a messenger is skipped (not in the SMS allowlist)', async () => {
    const order = await seedOrder(db, { status: 'ordered_at_supplier' });
    const smsBefore = gateway.calls.length;
    const orderEventId = await journalEvent(db, order.orderId);
    expect(
      await processNotify(
        job('order', { orderEventId, audience: 'client', template: 'ordered' }),
        t.deps,
      ),
    ).toEqual({ status: 'skipped', fallbackReason: 'no_messenger:not_in_sms_allowlist' });
    const [row] = await notificationRows(db, `${orderEventId}:ordered:`);
    expect(row).toMatchObject({
      dedupeKey: `${orderEventId}:ordered:none`,
      status: 'skipped',
      channel: null,
      fallbackReason: 'no_messenger:not_in_sms_allowlist',
    });
    expect(gateway.calls.length).toBe(smsBefore);
  });

  it('429: the job fails retryably, the row stays queued, the retry sends once', async () => {
    const order = await seedOrder(db, { status: 'ready' });
    await bindTelegram(db, order.userId);
    const orderEventId = await journalEvent(db, order.orderId);
    const data = { orderEventId, audience: 'client', template: 'paid' };
    telegram().failWith(429);
    try {
      const error = await processNotify(job('order', data), t.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TelegramRateLimitError);
      expect((error as TelegramRateLimitError).retryAfterSec).toBe(5);
    } finally {
      telegram().failWith(null);
    }
    const [queued] = await notificationRows(db, `${orderEventId}:paid:`);
    expect(queued).toMatchObject({ status: 'queued', attempts: 1 });
    expect(queued?.error).toContain('too many requests');
    expect(await processNotify(job('order', data, 1), t.deps)).toEqual({
      status: 'sent',
      channel: 'telegram',
    });
    expect(await processNotify(job('order', data, 2), t.deps)).toEqual({
      status: 'duplicate',
      existing: 'sent',
    });
    expect(await notificationRows(db, `${orderEventId}:paid:`)).toHaveLength(1);
  });

  it('claim_received, claim_decided and install_requested read the claim and the booking', async () => {
    const order = await seedOrder(db, { status: 'handed' });
    await bindTelegram(db, order.userId);
    const openedAt = new Date('2026-10-05T07:00:00Z');
    const [claim] = await db
      .insert(claims)
      .values({
        orderId: order.orderId,
        kind: 'defect',
        openedAt,
        deadlineAt: new Date(openedAt.getTime() + 10 * DAY),
        clientText: 'Течёт, звоните +79001234567',
        openedVia: 'web',
      })
      .returning();
    const claimEvent = await journalEvent(db, order.orderId, { claimId: claim!.id });
    await processNotify(
      job('order', { orderEventId: claimEvent, audience: 'client', template: 'claim_received' }),
      t.deps,
    );
    const received = telegram().sent().at(-1)!.text ?? '';
    expect(received).toContain('Претензия принята (брак). Что дальше:');
    expect(received).toContain('Ответим до 15 октября.');
    expect(received).not.toContain('Течёт');
    expect(received).not.toContain('9001234567');

    await db
      .update(claims)
      .set({ decision: 'reject', decisionText: 'Иван, это не брак', decidedAt: new Date() })
      .where(eq(claims.id, claim!.id));
    const decided = await journalEvent(db, order.orderId, { claimId: claim!.id });
    await processNotify(
      job('order', { orderEventId: decided, audience: 'client', template: 'claim_decided' }),
      t.deps,
    );
    const decidedText = telegram().sent().at(-1)!.text ?? '';
    expect(decidedText).toContain('Ответ по претензии готов');
    expect(decidedText).not.toContain('не брак');

    const [booking] = await db
      .insert(installBookings)
      .values({
        orderId: order.orderId,
        userId: order.userId,
        slotAt: new Date('2026-10-08T09:00:00Z'),
        status: 'requested',
        createdVia: 'bot',
      })
      .returning();
    const requested = await journalEvent(db, order.orderId, { bookingId: booking!.id });
    await processNotify(
      job('order', { orderEventId: requested, audience: 'client', template: 'install_requested' }),
      t.deps,
    );
    const installText = telegram().sent().at(-1)!.text ?? '';
    expect(installText).toContain('Запись на установку: чт 8 окт 14:00, Тестовый сервис.');
    expect(installText).toContain('оплачивается в сервисе по его чеку');
    expect(installText).not.toMatch(/₽/u);
  });

  describe('notify/vin', () => {
    it('vin_proposal without a messenger goes by SMS with the /p/ link, once', async () => {
      const request = await seedVinRequest(db, { withProposal: true });
      const smsBefore = gateway.calls.length;
      const data = {
        vinRequestId: request.id,
        audience: 'client',
        template: 'vin_proposal',
        key: `vin:${request.id}:vin_proposal:1`,
        n: 1,
      };
      expect(await processNotify(job('vin', data), t.deps)).toEqual({
        status: 'sent',
        channel: 'sms',
      });
      expect(await processNotify(job('vin', data, 1), t.deps)).toEqual({
        status: 'duplicate',
        channel: null,
      });
      expect(gateway.calls.length).toBe(smsBefore + 1);
      const sms = gateway.calls.at(-1)!;
      expect(sms.searchParams.get('number')).toBe(request.phone.slice(1));
      const text = sms.searchParams.get('text') ?? '';
      expect(text).toBe(
        `Подбор по VIN № ${vinRequestNumber(request.id)} готов: цены и сроки по ссылке.\nhttps://detaly.test/p/${request.token}`,
      );
      const rows = await notificationRows(db, `vin:${request.id}:`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        dedupeKey: `vin:${request.id}:vin_proposal:1:sms`,
        vinRequestId: request.id,
        userId: request.userId,
        orderId: null,
        status: 'sent',
        channel: 'sms',
        fallbackReason: 'no_messenger',
      });
      expect(JSON.stringify(rows[0])).not.toContain(request.phone);
      expect(t.fakes.sellerCards.calls).toContainEqual({
        method: 'refreshVin',
        vinRequestId: request.id,
      });
    });

    it('vin_received: skipped without a messenger, Telegram with one; the master comment masked', async () => {
      const lonely = await seedVinRequest(db);
      expect(
        await processNotify(
          job('vin', {
            vinRequestId: lonely.id,
            audience: 'client',
            template: 'vin_received',
            key: `vin:${lonely.id}:vin_received:0`,
          }),
          t.deps,
        ),
      ).toEqual({
        status: 'skipped',
        channel: null,
        fallbackReason: 'no_messenger:not_in_sms_allowlist',
      });
      const [skipped] = await notificationRows(db, `vin:${lonely.id}:`);
      expect(skipped).toMatchObject({
        dedupeKey: `vin:${lonely.id}:vin_received:0:none`,
        status: 'skipped',
      });

      const bound = await seedVinRequest(db, { withProposal: true });
      const chatId = await bindTelegram(db, bound.userId);
      for (const template of ['vin_received', 'vin_proposal'] as const) {
        expect(
          await processNotify(
            job('vin', { vinRequestId: bound.id, audience: 'client', template, key: template }),
            t.deps,
          ),
        ).toEqual({ status: 'sent', channel: 'telegram' });
        const last = telegram().sent().at(-1)!;
        expect(last.chatId).toBe(chatId);
        expectNoPd(last.text ?? '', bound.phone);
      }
      const proposal = telegram().calls.at(-1)!.payload as {
        text: string;
        reply_markup: { inline_keyboard: { url?: string }[][] };
      };
      expect(proposal.text).toContain('Комментарий мастера: Берите MANN, звоните •••');
      expect(proposal.reply_markup.inline_keyboard[0]?.[0]?.url).toBe(
        `https://detaly.test/p/${bound.token}`,
      );
    });

    it('an undelivered proposal is a task for the sellers; a closed request gets nothing', async () => {
      const noSms = await createTestDeps({ db, envOverrides: ENV });
      try {
        const request = await seedVinRequest(db, { withProposal: true });
        const data = {
          vinRequestId: request.id,
          audience: 'client',
          template: 'vin_proposal',
          key: 'k',
        };
        expect(await processNotify(job('vin', data), noSms.deps)).toEqual({
          status: 'skipped',
          channel: null,
          fallbackReason: 'no_messenger:sms_unavailable',
        });
        expect(noSms.fakes.alerts.calls).toEqual([
          {
            audience: 'sellers',
            text: `Заявка VIN № ${vinRequestNumber(request.id)}: подборку не удалось отправить клиенту (no_messenger:sms_unavailable). Позвоните клиенту — телефон в админке.`,
            dedupeKey: `vin:${request.id}:proposal_undelivered:1`,
          },
        ]);

        const closed = await seedVinRequest(db, { withProposal: true, status: 'closed' });
        expect(
          await processNotify(job('vin', { ...data, vinRequestId: closed.id }), noSms.deps),
        ).toEqual({ status: 'skipped', channel: null, fallbackReason: 'vin_closed' });
        expect(noSms.fakes.alerts.calls).toHaveLength(1);
      } finally {
        await noSms.close();
      }
    });

    it('the sellers card goes through postVin once; the reminder card waits for no answer', async () => {
      const request = await seedVinRequest(db);
      const data = {
        vinRequestId: request.id,
        audience: 'sellers',
        key: `vin:${request.id}:card:0`,
      };
      expect(await processNotify(job('vin', data), t.deps)).toEqual({ status: 'posted' });
      expect(await processNotify(job('vin', data, 1), t.deps)).toEqual({
        status: 'duplicate',
        channel: null,
      });
      const posts = t.fakes.sellerCards.calls.filter(
        (c) => c.method === 'postVin' && c.input.vinRequestId === request.id,
      );
      expect(posts).toEqual([
        { method: 'postVin', input: { vinRequestId: request.id, note: null } },
      ]);
      const [row] = await notificationRows(db, `vin:${request.id}:`);
      expect(row).toMatchObject({
        dedupeKey: `vin:${request.id}:staff_vin_card:0:telegram`,
        template: 'staff_vin_card',
        status: 'sent',
        vinRequestId: request.id,
      });

      const reminder = {
        vinRequestId: request.id,
        audience: 'sellers',
        key: `reminder:vin:${request.id}:4h`,
        n: 1,
        note: 'Без ответа 4 ч',
        reminder: true,
      };
      expect(await processNotify(job('vin', reminder), t.deps)).toEqual({ status: 'posted' });
      expect(t.fakes.sellerCards.calls.at(-1)).toEqual({
        method: 'postVin',
        input: { vinRequestId: request.id, note: 'Без ответа 4 ч' },
      });

      const answered = await seedVinRequest(db, { withProposal: true });
      const before = t.fakes.sellerCards.calls.length;
      expect(
        await processNotify(job('vin', { ...reminder, vinRequestId: answered.id }), t.deps),
      ).toEqual({ status: 'skipped', channel: null, fallbackReason: 'vin_answered' });
      expect(t.fakes.sellerCards.calls.length).toBe(before);
    });
  });
});
