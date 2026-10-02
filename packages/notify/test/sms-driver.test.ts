import { inspect } from 'node:util';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ChannelBlockedError,
  type ChannelDriver,
  ChannelSkippedError,
  createNotifier,
  createSmsDriver,
  FALLBACK_REASONS,
  type OrderTemplateData,
  type RenderedMessage,
  rubToKopLoose,
  SMS_DEFAULT_API_URL,
  type SmsDriverOptions,
  SmsGatewayError,
  type SmsGuard,
  smsDriverOptionsFromEnv,
  type SmsLogger,
  UnrecoverableSmsError,
} from '../src';

const AERO = 'https://gate.sms.test/v2';
const SMSC = 'https://smsc.sms.test/sys';
const PHONE = '+79123456789';
const LOGIN = 'owner@example.test';
const KEY = 'sms-secret-key-123';
const URL_ORDER = 'https://detaly56.ru/o/token';
const TEXT = 'Нужно ваше решение по заказу DT-000123.';

const message: RenderedMessage = {
  text: TEXT,
  buttons: [
    [{ kind: 'action', text: 'Согласен', action: 'approve', orderId: 'x' }],
    [{ kind: 'url', text: 'Подробнее', url: URL_ORDER }],
  ],
};

interface Seen {
  url: URL;
  authorization: string | null;
}
const seen: Seen[] = [];
const record = (request: Request): void => {
  seen.push({ url: new URL(request.url), authorization: request.headers.get('authorization') });
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
});
afterAll(() => server.close());

function capturingLogger(): SmsLogger & { lines: unknown[] } {
  const lines: unknown[] = [];
  return {
    lines,
    info: (obj, msg) => lines.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }),
  };
}

/** Nothing secret or personal in an error or in the log lines. */
function assertClean(value: unknown): void {
  const dump = typeof value === 'string' ? value : `${inspect(value, { depth: 6 })}`;
  for (const secret of ['9123456789', '79123456789', LOGIN, KEY, 'решение', 'DT-000123']) {
    expect(dump).not.toContain(secret);
  }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

const aero = (over: Partial<SmsDriverOptions> = {}) =>
  createSmsDriver({
    provider: 'smsaero',
    login: LOGIN,
    apiKey: KEY,
    sender: 'DETALY',
    apiUrl: AERO,
    ...over,
  });

const smsc = (over: Partial<SmsDriverOptions> = {}) =>
  createSmsDriver({
    provider: 'smsc',
    login: 'detaly',
    apiKey: KEY,
    sender: 'DETALY',
    apiUrl: `${SMSC}/`,
    ...over,
  });

describe('SMS Aero driver', () => {
  it('sends GET /sms/send with Basic auth, number, text and sign', async () => {
    server.use(
      http.get(`${AERO}/sms/send`, ({ request }) => {
        record(request);
        return HttpResponse.json({
          success: true,
          data: { id: 4242, status: 0, cost: 3.69 },
          message: null,
        });
      }),
    );
    const logger = capturingLogger();
    const result = await aero({ logger }).send(PHONE, message);
    expect(result).toEqual({ externalId: '4242', costKop: 369 });
    const call = seen[0] as Seen;
    expect(call.url.searchParams.get('number')).toBe('79123456789');
    expect(call.url.searchParams.get('sign')).toBe('DETALY');
    expect(call.url.searchParams.get('text')).toBe(`${TEXT}\n${URL_ORDER}`);
    expect(call.authorization).toBe(`Basic ${Buffer.from(`${LOGIN}:${KEY}`).toString('base64')}`);
    expect(logger.lines).toEqual([
      { level: 'info', obj: { provider: 'smsaero', externalId: '4242' }, msg: 'sms sent' },
    ]);
    assertClean(JSON.stringify(logger.lines));
  });

  it('4xx -> UnrecoverableSmsError without the number, text or key', async () => {
    server.use(
      http.get(`${AERO}/sms/send`, () =>
        HttpResponse.json(
          { success: false, data: null, message: 'Invalid number 79123456789' },
          { status: 400 },
        ),
      ),
    );
    const logger = capturingLogger();
    const error = await failure(aero({ logger }).send(PHONE, message));
    expect(error).toBeInstanceOf(UnrecoverableSmsError);
    expect(error.message).toBe('smsaero: sms rejected (http 400)');
    assertClean(error);
    assertClean(JSON.stringify(logger.lines));
  });

  it('HTTP 200 with success=false -> UnrecoverableSmsError', async () => {
    server.use(
      http.get(`${AERO}/sms/send`, () =>
        HttpResponse.json({ success: false, data: null, message: 'Sign not approved' }),
      ),
    );
    const error = await failure(aero().send(PHONE, message));
    expect(error).toBeInstanceOf(UnrecoverableSmsError);
    expect((error as UnrecoverableSmsError).code).toBe('rejected');
  });

  it('5xx, 429 and network errors -> SmsGatewayError (queue retry)', async () => {
    server.use(http.get(`${AERO}/sms/send`, () => new HttpResponse('oops', { status: 502 })));
    const e502 = await failure(aero().send(PHONE, message));
    expect(e502).toBeInstanceOf(SmsGatewayError);
    expect(e502).not.toBeInstanceOf(UnrecoverableSmsError);
    expect(e502.message).toBe('smsaero: sms gateway unavailable (http 502)');

    server.use(http.get(`${AERO}/sms/send`, () => new HttpResponse(null, { status: 429 })));
    expect(await failure(aero().send(PHONE, message))).toBeInstanceOf(SmsGatewayError);

    server.use(http.get(`${AERO}/sms/send`, () => HttpResponse.error()));
    const network = await failure(aero().send(PHONE, message));
    expect(network).toBeInstanceOf(SmsGatewayError);
    expect(network.cause).toBeUndefined();
    assertClean(network);
  });

  it('broken JSON in a 2xx -> UnrecoverableSmsError (a retry could send twice)', async () => {
    server.use(
      http.get(
        `${AERO}/sms/send`,
        () =>
          new HttpResponse('{"success": tru', {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const error = await failure(aero().send(PHONE, message));
    expect(error).toBeInstanceOf(UnrecoverableSmsError);
    expect((error as UnrecoverableSmsError).code).toBe('malformed');
  });

  it('timeout -> SmsGatewayError', async () => {
    server.use(
      http.get(`${AERO}/sms/send`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json({ success: true, data: { id: 1 } });
      }),
    );
    const error = await failure(aero({ timeoutMs: 20 }).send(PHONE, message));
    expect(error).toBeInstanceOf(SmsGatewayError);
    expect((error as SmsGatewayError).code).toBe('timeout');
  });

  it('rejects a non-mobile or foreign number before calling the gateway', async () => {
    for (const address of ['+74951234567', '+380501234567', '', '89123']) {
      const error = await failure(aero().send(address, message));
      expect(error).toBeInstanceOf(UnrecoverableSmsError);
      expect(error.message).toBe('smsaero: sms rejected (invalid_number)');
    }
    expect(seen).toHaveLength(0);
  });

  it('requires a sender name and credentials', () => {
    expect(() => aero({ sender: null })).toThrow('sign');
    expect(() => aero({ login: '' })).toThrow('required');
  });
});

describe('smsc driver', () => {
  it('sends GET /send.php with fmt=3, charset=utf-8 and parses {id, cnt, cost}', async () => {
    server.use(
      http.get(`${SMSC}/send.php`, ({ request }) => {
        record(request);
        return HttpResponse.json({ id: 77, cnt: 2, cost: '7.80' });
      }),
    );
    const result = await smsc().send('8 (912) 345-67-89', message);
    expect(result).toEqual({ externalId: '77', costKop: 780 });
    const params = (seen[0] as Seen).url.searchParams;
    expect(Object.fromEntries(params)).toEqual({
      login: 'detaly',
      psw: KEY,
      phones: '79123456789',
      mes: `${TEXT}\n${URL_ORDER}`,
      sender: 'DETALY',
      fmt: '3',
      charset: 'utf-8',
      cost: '2',
    });
  });

  it('omits sender when not configured', async () => {
    server.use(
      http.get(`${SMSC}/send.php`, ({ request }) => {
        record(request);
        return HttpResponse.json({ id: 1, cnt: 1 });
      }),
    );
    expect(await smsc({ sender: null }).send(PHONE, message)).toEqual({
      externalId: '1',
      costKop: null,
    });
    expect((seen[0] as Seen).url.searchParams.has('sender')).toBe(false);
  });

  it('{error, error_code} -> UnrecoverableSmsError, codes 4 and 9 -> retry', async () => {
    server.use(
      http.get(`${SMSC}/send.php`, () =>
        HttpResponse.json({ error: 'invalid number 79123456789', error_code: 7 }),
      ),
    );
    const logger = capturingLogger();
    const error = await failure(smsc({ logger }).send(PHONE, message));
    expect(error).toBeInstanceOf(UnrecoverableSmsError);
    expect(error.message).toBe('smsc: sms rejected (error_code 7)');
    assertClean(error);
    assertClean(JSON.stringify(logger.lines));

    for (const code of [4, 9]) {
      server.use(
        http.get(`${SMSC}/send.php`, () => HttpResponse.json({ error: 'wait', error_code: code })),
      );
      expect(await failure(smsc().send(PHONE, message))).toBeInstanceOf(SmsGatewayError);
    }
  });

  it('4xx -> unrecoverable, 5xx -> retry, broken JSON -> unrecoverable', async () => {
    server.use(http.get(`${SMSC}/send.php`, () => new HttpResponse(null, { status: 403 })));
    expect(await failure(smsc().send(PHONE, message))).toBeInstanceOf(UnrecoverableSmsError);
    server.use(http.get(`${SMSC}/send.php`, () => new HttpResponse(null, { status: 503 })));
    expect(await failure(smsc().send(PHONE, message))).toBeInstanceOf(SmsGatewayError);
    server.use(http.get(`${SMSC}/send.php`, () => new HttpResponse('<html>')));
    const broken = await failure(smsc().send(PHONE, message));
    expect(broken).toBeInstanceOf(UnrecoverableSmsError);
    assertClean(broken);
  });

  it('the password in the query never reaches an error', async () => {
    server.use(http.get(`${SMSC}/send.php`, () => HttpResponse.error()));
    const error = await failure(smsc().send(PHONE, message));
    expect(error).toBeInstanceOf(SmsGatewayError);
    assertClean(error);
  });
});

describe('guard and Notifier', () => {
  const orderData: OrderTemplateData = {
    brandName: 'Тестовый бренд',
    orderId: '0192f0c4-7b1a-7cde-8f00-0123456789ab',
    orderNumber: 'DT-000123',
    orderUrl: URL_ORDER,
    scheme: 'prepay',
    items: [{ brand: 'MANN', article: 'W 914/2' }],
    replyBy: '2026-10-03T09:30:00Z',
  };
  const recipient = { kind: 'client' as const, bindings: [], phone: PHONE };

  it('a guard refusal is a skip with its reason; nothing goes to the gateway', async () => {
    const checks: { phone: string; dedupeKey?: string }[] = [];
    const guard: SmsGuard = {
      check: (phone, options) => {
        checks.push({ phone, ...options });
        return Promise.resolve({ allowed: false, reason: FALLBACK_REASONS.smsRateLimited });
      },
    };
    server.use(
      http.get(`${AERO}/sms/send`, ({ request }) => {
        record(request);
        return HttpResponse.json({ success: true, data: { id: 1 } });
      }),
    );
    const driver = aero({ guard });
    await expect(driver.send(PHONE, message)).rejects.toBeInstanceOf(ChannelSkippedError);

    const notifier = createNotifier({ drivers: [driver] });
    const result = await notifier.send(recipient, 'decision_needed', orderData, {
      dedupeKey: 'evt-1:decision_needed:sms',
    });
    expect(result).toEqual({
      status: 'skipped',
      fallbackReason: FALLBACK_REASONS.smsRateLimited,
      blocked: [],
    });
    expect(checks.at(-1)).toEqual({
      phone: '79123456789',
      dedupeKey: 'evt-1:decision_needed:sms',
    });
    expect(seen).toHaveLength(0);
  });

  it('allowed by the guard -> sent through the gateway with cost', async () => {
    const guard: SmsGuard = { check: () => Promise.resolve({ allowed: true }) };
    server.use(
      http.get(`${AERO}/sms/send`, ({ request }) => {
        record(request);
        return HttpResponse.json({ success: true, data: { id: 9, cost: '4.5' } });
      }),
    );
    const notifier = createNotifier({ drivers: [aero({ guard })] });
    const result = await notifier.send(recipient, 'decision_needed', orderData);
    expect(result).toEqual({
      status: 'sent',
      channel: 'sms',
      externalId: '9',
      costKop: 450,
      fallbackReason: FALLBACK_REASONS.noMessenger,
      blocked: [],
    });
    expect((seen[0] as Seen).url.searchParams.get('text')).toBe(
      `Нужно ваше решение по заказу DT-000123 до 14:30 03.10.\n${URL_ORDER}`,
    );
  });

  it('a blocked messenger, then an SMS rate limit: both in the reason', async () => {
    const blockedTelegram: ChannelDriver = {
      channel: 'telegram',
      send: () => Promise.reject(new ChannelBlockedError('telegram')),
    };
    const guard: SmsGuard = {
      check: () => Promise.resolve({ allowed: false, reason: FALLBACK_REASONS.smsBudgetExhausted }),
    };
    const notifier = createNotifier({ drivers: [blockedTelegram, aero({ guard })] });
    const result = await notifier.send(
      {
        kind: 'client',
        bindings: [{ channel: 'telegram', chatId: '5', isPrimary: true, blocked: false }],
        phone: PHONE,
      },
      'arrived',
      orderData,
    );
    expect(result).toMatchObject({
      status: 'skipped',
      fallbackReason: `blocked:telegram;${FALLBACK_REASONS.smsBudgetExhausted}`,
    });
  });
});

describe('helpers', () => {
  it('rubToKopLoose', () => {
    expect(rubToKopLoose(3.69)).toBe(369);
    expect(rubToKopLoose('1,40')).toBe(140);
    expect(rubToKopLoose('2')).toBe(200);
    expect(rubToKopLoose('0.125')).toBe(13);
    expect(rubToKopLoose('0.124')).toBe(12);
    expect(rubToKopLoose(-1)).toBeNull();
    expect(rubToKopLoose('abc')).toBeNull();
    expect(rubToKopLoose(null)).toBeNull();
  });

  it('smsDriverOptionsFromEnv', () => {
    const env = {
      SMS_PROVIDER: 'smsaero' as const,
      SMS_LOGIN: LOGIN,
      SMS_API_KEY: KEY,
      SMS_SENDER: 'DETALY',
      SMS_API_URL: undefined,
    };
    expect(smsDriverOptionsFromEnv(env)).toEqual({
      provider: 'smsaero',
      login: LOGIN,
      apiKey: KEY,
      sender: 'DETALY',
      apiUrl: null,
    });
    expect(smsDriverOptionsFromEnv({ ...env, SMS_PROVIDER: 'none' })).toBeNull();
    expect(smsDriverOptionsFromEnv({ ...env, SMS_API_KEY: undefined })).toBeNull();
    expect(smsDriverOptionsFromEnv({ ...env, SMS_SENDER: undefined })).toBeNull();
    expect(
      smsDriverOptionsFromEnv({ ...env, SMS_PROVIDER: 'smsc', SMS_SENDER: undefined }),
    ).toMatchObject({ provider: 'smsc', sender: null });
    expect(SMS_DEFAULT_API_URL).toEqual({
      smsaero: 'https://gate.smsaero.ru/v2',
      smsc: 'https://smsc.ru/sys',
    });
  });
});
