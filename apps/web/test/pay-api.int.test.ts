// POST /api/orders/<token>/pay and the order page after the payment page (section 14.1, 14.4,
// 14.7) against local PG with the msw emulation of YooKassa. Requests reach msw through the
// adapter's injected fetch (msw `getResponse`), not setupServer: msw 3 intercepts every socket
// in the process, PostgreSQL and Redis included.
import { randomBytes, randomInt } from 'node:crypto';
import {
  asc,
  createDb,
  eq,
  orderEvents,
  orderItems,
  orders,
  outbox,
  payments,
  receipts,
  sql,
  users,
  type Db,
} from '@detaly/db';
import type { Offer, OrderStatus, PaymentScheme } from '@detaly/domain';
import { applyPaymentObject, type EngineDeps } from '@detaly/orders';
import {
  createPaymentsFromEnv,
  PaymentProviderError,
  PaymentRequestError,
  type Payments,
} from '@detaly/payments';
import { createYooKassaMock, type YooKassaMock } from '@detaly/payments/testing';
import { getResponse } from 'msw';
import type * as Navigation from 'next/navigation';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderDetails } from '@/components/order/OrderDetails';
import { loadOrderView, type OrderView } from '@/server/orders/order-view';
import {
  PAY_CHECK_WINDOW_MS,
  parsePayNotice,
  payCheckState,
  type PayNotice,
} from '@/server/orders/pay-notice';
import {
  handlePayRequest,
  paymentRejection,
  type PayHandlerDeps,
} from '@/server/payments/pay-handler';
import { intEnv, webDatabaseUrl } from './helpers';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const APP = 'http://127.0.0.1:3100';
const SHOP = { shopId: 'test-shop', secretKey: 'test-secret' } as const;
const PAYMENT_ENV = {
  APP_BASE_URL: APP,
  YOOKASSA_SHOP_ID: SHOP.shopId,
  YOOKASSA_SECRET_KEY: SHOP.secretKey,
  YOOKASSA_VAT_CODE: '1',
  YOOKASSA_TAX_SYSTEM_CODE: '2',
};

let db: Db;
let mock: YooKassaMock;
let provider: Payments;
let logs: { level: string; details: Record<string, unknown>; message: string }[] = [];
const env = intEnv(PAYMENT_ENV);
const disabledEnv = intEnv({ APP_BASE_URL: APP });

const logger = {
  info: (details: object, message: string) =>
    logs.push({ level: 'info', details: details as Record<string, unknown>, message }),
  warn: (details: object, message: string) =>
    logs.push({ level: 'warn', details: details as Record<string, unknown>, message }),
  error: (details: object, message: string) =>
    logs.push({ level: 'error', details: details as Record<string, unknown>, message }),
} as unknown as NonNullable<PayHandlerDeps['logger']>;

const mockFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const response = await getResponse(mock.handlers, request);
  if (response === undefined) throw new Error(`unhandled YooKassa request ${request.url}`);
  if (response.type === 'error') throw new TypeError('fetch failed');
  return response;
};

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 4 });
  mock = createYooKassaMock({ ...SHOP });
  const created = createPaymentsFromEnv(env, { fetch: mockFetch, timeoutMs: 5_000 });
  if (created === null) throw new Error('payments should be enabled');
  provider = created;
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  mock.reset();
  logs = [];
});

function engine(): EngineDeps {
  return { db, env, nudge: () => undefined };
}

function deps(overrides: Partial<PayHandlerDeps> = {}): PayHandlerDeps {
  return {
    engine: engine(),
    payments: provider.payments,
    appBaseUrl: APP,
    logger,
    ...overrides,
  };
}

function offer(brand: string, article: string, isLocal: boolean): Offer {
  return {
    source: 'rossko',
    brand,
    article,
    articleNorm: article.replace(/[^A-Za-z0-9]/g, '').toUpperCase(),
    name: 'Фильтр масляный',
    group: null,
    isCross: false,
    priceSupplierKop: 41_250,
    stock: {
      stockId: isLocal ? 'ORB1' : 'MSK7',
      isLocal,
      count: 10,
      multiplicity: 1,
      type: null,
      deliveryDays: isLocal ? 0 : 3,
      deliveryStart: null,
      deliveryEnd: null,
      extra: null,
      description: null,
    },
  };
}

interface Seeded {
  id: string;
  token: string;
  number: string;
  phone: string;
}

async function seedOrder({
  status = 'awaiting_payment',
  scheme = 'prepay',
}: { status?: OrderStatus; scheme?: PaymentScheme } = {}): Promise<Seeded> {
  const phone = `+79${randomInt(100_000_000, 1_000_000_000)}`;
  const [user] = await db.insert(users).values({ phone, name: 'Платёж Тестов' }).returning();
  if (!user) throw new Error('user not inserted');
  const token = randomBytes(32).toString('base64url');
  const [order] = await db
    .insert(orders)
    .values({
      userId: user.id,
      accessToken: token,
      status,
      paymentScheme: scheme,
      subtotalKop: 2 * 52_800 + 117_000,
      totalKop: 2 * 52_800 + 117_000,
      itemsHash: 'test',
      promisedDate: '2026-10-08',
      pickupCode: '482913',
      expiresAt: new Date(Date.now() + 2 * 3600_000),
    })
    .returning();
  if (!order) throw new Error('order not inserted');
  await db.insert(orderItems).values([
    {
      orderId: order.id,
      offerKey: 'OC90:Knecht:ORB1',
      searchArticleNorm: 'OC90',
      brand: 'Knecht',
      article: 'OC 90',
      name: 'Фильтр масляный',
      qty: 2,
      stockId: 'ORB1',
      isLocal: true,
      priceSupplierAtOrderKop: 41_250,
      priceClientKop: 52_800,
      markupBp: 2800,
      etaDate: '2026-10-03',
      offerSnapshot: offer('Knecht', 'OC 90', true),
      state: 'pending',
    },
    {
      orderId: order.id,
      offerKey: '0451103079:BOSCH:MSK7',
      searchArticleNorm: 'OC90',
      brand: 'BOSCH',
      article: '0 451 103 079',
      name: 'Фильтр масляный',
      qty: 1,
      stockId: 'MSK7',
      isLocal: false,
      priceSupplierAtOrderKop: 90_000,
      priceClientKop: 117_000,
      markupBp: 3000,
      etaDate: '2026-10-07',
      offerSnapshot: offer('BOSCH', '0 451 103 079', false),
      state: 'pending',
    },
  ]);
  await db.insert(orderEvents).values({
    orderId: order.id,
    type: 'checkout',
    fromStatus: 'draft',
    toStatus: status === 'awaiting_confirmation' ? status : 'awaiting_payment',
    actorType: 'client',
    actorId: user.id,
    payload: { scheme },
  });
  return { id: order.id, token, number: order.number, phone };
}

function payRequest(
  token: string,
  {
    json = false,
    headers = { Origin: APP },
  }: { json?: boolean; headers?: Record<string, string> } = {},
): Request {
  return new Request(`${APP}/api/orders/${token}/pay`, {
    method: 'POST',
    headers: json
      ? { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }
      : { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html', ...headers },
    body: json ? '{}' : '',
  });
}

async function pay(token: string, options?: Parameters<typeof payRequest>[1], d = deps()) {
  const response = await handlePayRequest(payRequest(token, options), token, d);
  const body = response.headers.get('content-type')?.includes('json')
    ? ((await response.json()) as Record<string, unknown>)
    : null;
  return { status: response.status, location: response.headers.get('location'), body, response };
}

async function paymentRows(orderId: string) {
  return db
    .select()
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(asc(payments.createdAt));
}

function postPayments() {
  return mock.requests.filter((r) => r.method === 'POST' && r.path === '/payments');
}

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function render(view: OrderView, notice: PayNotice, nowMs = Date.now()): string {
  return renderToStaticMarkup(
    createElement(OrderDetails, {
      view,
      pickup: { name: null, address: 'г. Оренбург, ул. Тестовая, 1', hours: null, phone: null },
      contactPhone: null,
      cartReminder: null,
      notice,
      nowMs,
    }),
  );
}

async function viewOf(token: string, enabled = true): Promise<OrderView> {
  const view = await loadOrderView(db, token, {
    env: enabled ? env : disabledEnv,
    paymentsEnabled: enabled,
  });
  if (!view) throw new Error('view missing');
  return view;
}

describe('POST /api/orders/<token>/pay', () => {
  it('two clicks create exactly one payment and both lead to its confirmation page', async () => {
    const order = await seedOrder();
    const first = await pay(order.token);
    expect(first.status).toBe(303);
    expect(first.response.headers.get('cache-control')).toBe('no-store');
    const [row] = await paymentRows(order.id);
    expect(row).toMatchObject({
      status: 'pending',
      kind: 'prepayment',
      amountKop: 222_600,
      confirmationType: 'redirect',
    });
    expect(row?.providerPaymentId).toBeTruthy();
    expect(first.location).toBe(row?.confirmationUrl);
    expect(first.location).toMatch(/^https:\/\//);

    const second = await pay(order.token);
    expect(second.status).toBe(303);
    expect(second.location).toBe(first.location);
    expect(await paymentRows(order.id)).toHaveLength(1);
    expect(postPayments()).toHaveLength(1);
    expect(mock.payments.size).toBe(1);

    // The request: amount = orders.total, return_url back to the order page, a receipt.
    const body = postPayments()[0]?.body as Record<string, unknown>;
    expect(body.amount).toEqual({ value: '2226.00', currency: 'RUB' });
    expect(body.confirmation).toEqual({
      type: 'redirect',
      return_url: `${APP}/o/${order.token}?paid=1`,
    });
    expect(body.receipt).toBeTruthy();
    expect(body.metadata).toMatchObject({ order_id: order.id, payment_row_id: row?.id });
    const [receipt] = await db.select().from(receipts).where(eq(receipts.orderId, order.id));
    expect(receipt).toMatchObject({ kind: 'prepayment', status: 'pending', paymentId: row?.id });
    const journal = await db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order.id))
      .orderBy(asc(orderEvents.createdAt));
    expect(journal.filter((e) => e.type === 'payment_created')).toHaveLength(1);

    // Logs: the order number, never the token, the phone or the payment link.
    const text = JSON.stringify(logs);
    expect(text).toContain(order.number);
    expect(text).not.toContain(order.token);
    expect(text).not.toContain(order.phone);
    expect(text).not.toContain(String(first.location));
  });

  it('a provider error: back to the page with ?pay=error; the retry repeats the same Idempotence-Key', async () => {
    const order = await seedOrder();
    mock.failNext('POST /payments', 503);
    const failed = await pay(order.token);
    expect(failed.status).toBe(303);
    expect(failed.location).toBe(`${APP}/o/${order.token}?pay=error`);
    const [pending] = await paymentRows(order.id);
    expect(pending).toMatchObject({ status: 'pending', providerPaymentId: null });
    expect(logs.find((l) => l.message === 'pay: payment creation failed')?.details).toMatchObject({
      order: order.number,
      status: 503,
    });

    const retried = await pay(order.token);
    expect(retried.status).toBe(303);
    expect(retried.location).toMatch(/^https:\/\//);
    const rows = await paymentRows(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerPaymentId).toBeTruthy();
    const keys = postPayments().map((r) => r.idempotenceKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(rows[0]?.idempotenceKey);
    expect(mock.payments.size).toBe(1);
  });

  it('a refusal (HTTP 4xx) closes the row: the next click takes a new key, the owner is told once', async () => {
    const order = await seedOrder();
    mock.failNext('POST /payments', 400);
    const failed = await pay(order.token);
    expect(failed.location).toBe(`${APP}/o/${order.token}?pay=error`);
    const [closed] = await paymentRows(order.id);
    expect(closed).toMatchObject({ status: 'canceled', providerPaymentId: null });
    expect(closed?.cancellationReason).toMatch(/^rejected:.*\(HTTP 400\)$/u);

    const retried = await pay(order.token);
    expect(retried.location).toMatch(/^https:\/\//);
    const rows = await paymentRows(order.id);
    expect(rows.map((r) => r.status)).toEqual(['canceled', 'pending']);
    const keys = postPayments().map((r) => r.idempotenceKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    const alerts = await db
      .select()
      .from(outbox)
      .where(sql`${outbox.data}->>'orderId' = ${order.id} and ${outbox.queue} = 'notify'`);
    expect(alerts.map((r) => (r.data as { template: string }).template)).toEqual([
      'staff_payment_rejected',
    ]);
    expect(JSON.stringify(logs)).not.toContain(order.token);
  });

  it('paymentRejection: only a final 4xx or a local refusal proves no payment exists', () => {
    expect(
      paymentRejection(
        new PaymentProviderError('bad', { status: 400, code: 'invalid_request', retryable: false }),
      ),
    ).toBe('invalid_request (HTTP 400)');
    expect(paymentRejection(new PaymentRequestError('too long'))).toBe('PaymentRequestError');
    for (const error of [
      new PaymentProviderError('busy', { status: 429, code: 'too_many_requests', retryable: true }),
      new PaymentProviderError('down', { status: 503, code: null, retryable: true }),
      new PaymentProviderError('garbled', { status: 200, code: 'bad_response', retryable: false }),
      new PaymentProviderError('timeout', { status: null, code: 'timeout', retryable: true }),
      new TypeError('fetch failed'),
    ]) {
      expect(paymentRejection(error)).toBeNull();
    }
  });

  it('the response was lost after YooKassa processed it: the next click gets the same payment', async () => {
    const order = await seedOrder();
    mock.failNext('POST /payments', 'network', { afterProcessing: true });
    expect((await pay(order.token)).location).toContain('?pay=error');
    expect(mock.payments.size).toBe(1);
    const again = await pay(order.token);
    expect(again.location).toMatch(/^https:\/\//);
    expect(mock.payments.size).toBe(1);
    expect(await paymentRows(order.id)).toHaveLength(1);
  });

  it('JSON callers get { redirectUrl } and error codes', async () => {
    const order = await seedOrder();
    const res = await pay(order.token, { json: true });
    expect(res.status).toBe(200);
    expect(res.body?.redirectUrl).toMatch(/^https:\/\//);

    const confirmed = await seedOrder({ status: 'confirmed' });
    const notPayable = await pay(confirmed.token, { json: true });
    expect(notPayable.status).toBe(409);
    expect(notPayable.body).toMatchObject({ error: 'not_payable' });

    const disabled = await pay(order.token, { json: true }, deps({ payments: null }));
    expect(disabled.status).toBe(503);
    expect(disabled.body).toMatchObject({ error: 'payments_disabled' });
  });

  it('a form post for an order that does not wait for payment goes back to the page', async () => {
    const confirmed = await seedOrder({ status: 'confirmed' });
    const res = await pay(confirmed.token);
    expect(res.status).toBe(303);
    expect(res.location).toBe(`${APP}/o/${confirmed.token}`);
    const handover = await seedOrder({
      status: 'awaiting_confirmation',
      scheme: 'pay_on_handover',
    });
    expect((await pay(handover.token)).location).toBe(`${APP}/o/${handover.token}`);
    expect(postPayments()).toHaveLength(0);
  });

  it('without the YooKassa keys: ?pay=unavailable and the page keeps «Оплата подключается»', async () => {
    const order = await seedOrder();
    const res = await pay(order.token, undefined, deps({ payments: null }));
    expect(res.status).toBe(303);
    expect(res.location).toBe(`${APP}/o/${order.token}?pay=unavailable`);
    expect(await paymentRows(order.id)).toHaveLength(0);

    const view = await viewOf(order.token, false);
    expect(view.paymentsEnabled).toBe(false);
    expect(view.actions.pay).toBe(false);
    const html = render(view, parsePayNotice({}));
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="pay-button"/);
    expect(plain(html)).toContain('Оплата подключается');
    expect(html).not.toContain('/pay"');
  });

  it('403 for a foreign Origin or none, 404 for a malformed or unknown token', async () => {
    const order = await seedOrder();
    expect((await pay(order.token, { headers: { Origin: 'https://evil.test' } })).status).toBe(403);
    expect((await pay(order.token, { headers: {} })).status).toBe(403);
    expect((await pay('short')).status).toBe(404);
    const unknown = randomBytes(32).toString('base64url');
    const res = await pay(unknown, { json: true });
    expect(res.status).toBe(404);
    expect(postPayments()).toHaveLength(0);
  });

  it('accepts the form post a browser sends from /o/<token> (Referrer-Policy: no-referrer)', async () => {
    // Chromium sends `Origin: null` for a same-origin form POST from a no-referrer page.
    const order = await seedOrder();
    const browserForm = await pay(order.token, {
      headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' },
    });
    expect(browserForm.status).toBe(303);
    expect(browserForm.location).toMatch(/^https:\/\//);
    expect(postPayments()).toHaveLength(1);
    // The same opaque origin from another site is still CSRF.
    const crossSite = await pay(order.token, {
      headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    expect(postPayments()).toHaveLength(1);
  });

  it('the CSP lets the pay form follow its 303 to the YooKassa confirmation page', async () => {
    // Chromium applies form-action to the redirects of a form submission: with `form-action
    // 'self'` alone the «Оплатить» click is blocked before it reaches YooKassa. The policy is
    // sent by src/proxy.ts with a nonce per request (lib/csp.ts, audit tech-3).
    const { contentSecurityPolicy } = await import('@/lib/csp');
    const csp = contentSecurityPolicy('bm9uY2U=');
    const formAction = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('form-action '));
    expect(formAction?.split(/\s+/)).toEqual(
      // t.me: the «Статусы в Telegram» form follows its 303 to the client bot's deep link.
      expect.arrayContaining(["'self'", 'https://yoomoney.ru', 'https://t.me']),
    );
    const order = await seedOrder();
    const { location } = await pay(order.token);
    expect(new URL(String(location)).origin).toBe('https://yoomoney.ru');
  });
});

describe('/o/<token> payment block', () => {
  it('awaiting payment with payments enabled: an active «Оплатить» form, no phone in the HTML', async () => {
    const order = await seedOrder();
    const view = await viewOf(order.token);
    expect(view.actions.pay).toBe(true);
    const html = render(view, parsePayNotice({}));
    expect(html).toContain(`action="/api/orders/${order.token}/pay"`);
    expect(html).toMatch(/<button type="submit"[^>]*data-testid="pay-button"/);
    expect(plain(html)).toContain('Оплатить 2 226 ₽');
    expect(html).not.toContain(order.phone);
    expect(html).not.toContain(order.phone.slice(1));
    expect(html).not.toContain('Платёж Тестов');
  });

  it('?pay=error shows the retry message with the button', async () => {
    const order = await seedOrder();
    const html = render(await viewOf(order.token), parsePayNotice({ pay: 'error' }));
    expect(plain(html)).toContain('Не удалось создать платёж, попробуйте ещё раз');
    expect(html).toContain('data-testid="pay-button"');
  });

  it('?paid=1 while pending: «Проверяем оплату…» with a refresh, for two minutes at most', async () => {
    const order = await seedOrder();
    await pay(order.token);
    const view = await viewOf(order.token);
    expect(view.payment).toEqual({ status: 'pending', kind: 'prepayment' });

    const now = Date.now();
    const notice = parsePayNotice({ paid: '1' }, now);
    expect(payCheckState(view, notice, now)).toEqual({
      kind: 'checking',
      refreshUrl: `/o/${order.token}?paid=1&since=${now}`,
      refreshSec: 5,
    });
    const html = render(view, notice, now);
    expect(plain(html)).toContain('Проверяем оплату…');
    expect(html).toContain(
      `http-equiv="refresh" content="5;url=/o/${order.token}?paid=1&amp;since=${now}"`,
    );
    // No pay button while the payment is being checked.
    expect(html).not.toContain('data-testid="pay-button"');

    // The loop keeps its start; after two minutes it stops refreshing.
    const later = now + PAY_CHECK_WINDOW_MS + 1;
    const stale = parsePayNotice({ paid: '1', since: String(now) }, later);
    const slowHtml = render(view, stale, later);
    expect(slowHtml).not.toContain('http-equiv="refresh"');
    expect(plain(slowHtml)).toContain('Оплата ещё не подтвердилась');
    expect(slowHtml).toContain('data-testid="pay-button"');
  });

  it('?paid=1 after the payment succeeded: the order is paid, «Оплата получена»', async () => {
    const order = await seedOrder();
    await pay(order.token);
    const [row] = await paymentRows(order.id);
    mock.setPaymentStatus(String(row?.providerPaymentId), 'succeeded');
    const remote = await provider.payments.getPayment(String(row?.providerPaymentId));
    await applyPaymentObject(engine(), remote, { source: 'webhook' });

    const view = await viewOf(order.token);
    expect(view.status).toBe('confirmed');
    const html = render(view, parsePayNotice({ paid: '1' }));
    expect(plain(html)).toContain('Оплата получена');
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain('data-testid="pay-button"');
    expect(view.timeline.map((e) => e.text)).toContain('Оплата получена');
  });

  it('?paid=1 after a canceled payment: the order is cancelled, no refresh', async () => {
    const order = await seedOrder();
    await pay(order.token);
    const [row] = await paymentRows(order.id);
    mock.setPaymentStatus(String(row?.providerPaymentId), 'canceled');
    const remote = await provider.payments.getPayment(String(row?.providerPaymentId));
    await applyPaymentObject(engine(), remote, { source: 'webhook' });
    const view = await viewOf(order.token);
    expect(payCheckState(view, parsePayNotice({ paid: '1' }))).toEqual({ kind: 'failed' });
    const html = render(view, parsePayNotice({ paid: '1' }));
    expect(html).not.toContain('http-equiv="refresh"');
    expect(view.timeline.map((e) => e.text)).toContain('Платёж не прошёл, заказ отменён');
  });

  it('parsePayNotice ignores junk and stale starts', () => {
    const now = 1_800_000_000_000;
    expect(parsePayNotice({ paid: ['1', '0'], pay: 'boom', since: 'x' }, now)).toEqual({
      paid: true,
      payError: null,
      since: null,
    });
    expect(parsePayNotice({ since: String(now + 1) }, now).since).toBeNull();
    expect(parsePayNotice({ since: String(now - 2 * 86_400_000) }, now).since).toBeNull();
    expect(parsePayNotice({ pay: 'unavailable', since: String(now - 1000) }, now)).toEqual({
      paid: false,
      payError: 'unavailable',
      since: now - 1000,
    });
  });
});
