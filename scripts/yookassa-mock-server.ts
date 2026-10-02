/**
 * YooKassa API v3 mock for the phase 1B e2e run (docs/phase-1b-implementation.md section 16.4):
 * a plain node:http server over the msw emulation of @detaly/payments/testing
 * (createYooKassaMock), answered through msw `getResponse` without intercepting any socket.
 *
 *   node --import tsx scripts/yookassa-mock-server.ts [--port 3199] [--host 127.0.0.1]
 *     [--webhook http://127.0.0.1:3100/api/webhooks/yookassa] [--webhook-ip 127.0.0.1]
 *     [--shop-id test-shop --secret test-secret] [--receipt-status succeeded]
 *
 * Web and worker talk to it with YOOKASSA_API_URL=http://127.0.0.1:3199/v3.
 *
 * - `/v3/*`: the emulated API (Basic auth, Idempotence-Key, receipts, refunds, lists).
 * - A redirect payment gets confirmation_url = `<base>/checkout/<id>` instead of the YooKassa
 *   page; a QR payment gets confirmation_data = `<base>/qr/<id>` (what the client's phone
 *   would open after scanning the code shown to the seller).
 * - `GET /checkout/<id>[?result=canceled]`: the "bank page". Marks the payment succeeded (or
 *   canceled), POSTs the notification to web with `X-Real-IP: <webhook-ip>` (the address Caddy
 *   would put there; it must be in YOOKASSA_WEBHOOK_IP_ALLOWLIST) and redirects (303) to the
 *   payment's return_url.
 * - `GET /qr/<id>`: the same for a QR payment, answered with a short HTML page.
 * - `GET /__mock/health`, `GET /__mock/payments` (id, status, amount, metadata, confirmation:
 *   lets an e2e test find the QR payment of an order by its number), `POST /__mock/reset`.
 *
 * VERIFY: the emulation is not the real API (docs/external.md, Ю1–Ю13): the real confirmation
 * page, 3-D Secure, notification retries and receipt registration delays are not modelled. By
 * default receipts sent with POST /receipts register at once (`--receipt-status succeeded`), so
 * the e2e run does not wait for the 2-minute receipt polling.
 *
 * Logs: method, path and status only (the stored receipts carry customer phones).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createYooKassaMock,
  type YooKassaMock,
  type YooKassaMockOptions,
} from '../packages/payments/src/testing/yookassa-handlers';

type GetResponse = (
  handlers: YooKassaMock['handlers'],
  request: Request,
) => Promise<Response | undefined>;

/** msw is a dependency of @detaly/payments, not of the repo root: resolve it from there. */
async function loadGetResponse(): Promise<GetResponse> {
  const require = createRequire(new URL('../packages/payments/package.json', import.meta.url));
  const entry = pathToFileURL(require.resolve('msw')).href;
  const msw = (await import(entry)) as { getResponse?: GetResponse };
  if (typeof msw.getResponse !== 'function') throw new Error('msw getResponse is missing');
  return msw.getResponse;
}

type ObjectStatus = NonNullable<YooKassaMockOptions['receiptStatus']>;
const OBJECT_STATUSES: readonly ObjectStatus[] = ['pending', 'succeeded', 'canceled'];

const USAGE =
  'Использование: node --import tsx scripts/yookassa-mock-server.ts [--port 3199] [--host 127.0.0.1] [--webhook URL] [--webhook-ip IP] [--shop-id ID --secret KEY] [--receipt-status pending|succeeded|canceled]';

interface Options {
  host: string;
  port: number;
  webhookUrl: string;
  webhookIp: string;
  shopId: string | undefined;
  secretKey: string | undefined;
  receiptStatus: ObjectStatus;
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '3199' },
      webhook: { type: 'string', default: 'http://127.0.0.1:3100/api/webhooks/yookassa' },
      'webhook-ip': { type: 'string', default: '127.0.0.1' },
      'shop-id': { type: 'string' },
      secret: { type: 'string' },
      'receipt-status': { type: 'string', default: 'succeeded' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const port = Number(values.port);
  const receiptStatus = values['receipt-status'] as ObjectStatus;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(USAGE);
  if (!OBJECT_STATUSES.includes(receiptStatus)) throw new Error(USAGE);
  return {
    host: values.host,
    port,
    webhookUrl: values.webhook,
    webhookIp: values['webhook-ip'],
    shopId: values['shop-id'],
    secretKey: values.secret,
    receiptStatus,
  };
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), name: 'yookassa-mock', ...fields }));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function toRequest(req: IncomingMessage, base: string, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = req.method ?? 'GET';
  return new Request(new URL(req.url ?? '/', base), {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' || body.length === 0 ? undefined : body,
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function html(status: number, title: string, text: string): Response {
  const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font-family:sans-serif;margin:16px"><h1>${title}</h1><p>${text}</p></body></html>`;
  return new Response(page, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export interface MockServer {
  mock: YooKassaMock;
  close(): Promise<void>;
}

export async function startMockServer(options: Options): Promise<MockServer> {
  const getResponse = await loadGetResponse();
  const base = `http://${options.host}:${options.port}`;
  const mock = createYooKassaMock({
    apiUrl: `${base}/v3`,
    shopId: options.shopId,
    secretKey: options.secretKey,
    receiptStatus: options.receiptStatus,
  });

  /** The payment pages of the mock replace the YooKassa ones (both live in the store). */
  function localizeConfirmation(payment: Json): void {
    const id = String(payment.id);
    const confirmation = payment.confirmation;
    if (!isRecord(confirmation)) return;
    if (confirmation.type === 'redirect') confirmation.confirmation_url = `${base}/checkout/${id}`;
    if (confirmation.type === 'qr') confirmation.confirmation_data = `${base}/qr/${id}`;
  }

  async function api(request: Request): Promise<Response> {
    const response = await getResponse(mock.handlers, request);
    if (response === undefined) {
      return Response.json(
        { type: 'error', code: 'not_found', description: 'mock: unknown endpoint' },
        { status: 404 },
      );
    }
    if (response.type === 'error') return new Response('mock: connection failure', { status: 502 });
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/v3/payments' && response.ok) {
      const body = (await response.json()) as Json;
      const stored = mock.payments.get(String(body.id));
      if (stored !== undefined) {
        // The store object is the one replayed for the same Idempotence-Key too.
        localizeConfirmation(stored);
        return Response.json(stored, { status: response.status });
      }
      return Response.json(body, { status: response.status });
    }
    return response;
  }

  async function notify(event: string, id: string): Promise<number | null> {
    try {
      const answer = await fetch(options.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Real-IP': options.webhookIp },
        body: JSON.stringify(mock.notification(event, id)),
        signal: AbortSignal.timeout(10_000),
      });
      await answer.arrayBuffer().catch(() => undefined);
      return answer.status;
    } catch (error) {
      log({ msg: 'webhook failed', event, err: error instanceof Error ? error.name : 'error' });
      return null;
    }
  }

  /** The client paid (or gave up): status, notification, then where to send the browser. */
  async function settle(
    id: string,
    result: 'succeeded' | 'canceled',
  ): Promise<{ ok: true; payment: Json } | { ok: false; response: Response }> {
    const payment = mock.payments.get(id);
    if (payment === undefined) {
      return { ok: false, response: html(404, 'Платёж не найден', 'Ссылка устарела.') };
    }
    if (payment.status !== 'pending') {
      // A second visit: nothing changes, the browser still goes back to the shop.
      return { ok: true, payment };
    }
    mock.setPaymentStatus(id, result);
    const event = result === 'succeeded' ? 'payment.succeeded' : 'payment.canceled';
    const status = await notify(event, id);
    log({ msg: 'payment settled', result, webhookStatus: status });
    return { ok: true, payment };
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/v3' || path.startsWith('/v3/')) return api(request);

    const checkout = /^\/checkout\/([0-9a-f-]{36})$/u.exec(path);
    if (checkout && request.method === 'GET') {
      const result = url.searchParams.get('result') === 'canceled' ? 'canceled' : 'succeeded';
      const settled = await settle(checkout[1] as string, result);
      if (!settled.ok) return settled.response;
      const confirmation = settled.payment.confirmation;
      const returnUrl = isRecord(confirmation) ? confirmation.return_url : undefined;
      if (typeof returnUrl === 'string') {
        return new Response(null, { status: 303, headers: { Location: returnUrl } });
      }
      return html(200, 'Оплата', 'Платёж обработан, вернитесь в магазин.');
    }

    const qr = /^\/qr\/([0-9a-f-]{36})$/u.exec(path);
    if (qr && request.method === 'GET') {
      const settled = await settle(qr[1] as string, 'succeeded');
      if (!settled.ok) return settled.response;
      return html(200, 'Оплачено', 'Оплата по QR прошла (эмуляция ЮKassa).');
    }

    if (path === '/__mock/health') return Response.json({ ok: true });
    if (path === '/__mock/payments' && request.method === 'GET') {
      // No receipts here: they carry the customer's phone.
      const items = [...mock.payments.values()].map((p) => ({
        id: p.id,
        status: p.status,
        amount: p.amount,
        metadata: p.metadata,
        confirmation: p.confirmation,
        created_at: p.created_at,
      }));
      return Response.json({ items });
    }
    if (path === '/__mock/reset' && request.method === 'POST') {
      mock.reset();
      return Response.json({ ok: true });
    }
    return html(404, 'Не найдено', 'Неизвестный адрес мока ЮKassa.');
  }

  const server = createServer((req, res) => {
    void (async () => {
      let status = 500;
      try {
        const body = await readBody(req);
        const response = await route(toRequest(req, base, body));
        status = response.status;
        await send(res, response);
      } catch (error) {
        log({ msg: 'mock error', err: error instanceof Error ? error.message : 'error' });
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('mock error');
      } finally {
        log({ method: req.method, path: new URL(req.url ?? '/', base).pathname, status });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  log({ msg: 'listening', base });
  return {
    mock,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : USAGE);
    process.exit(64);
  }
  const server = await startMockServer(options);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void server.close().finally(() => process.exit(0));
    });
  }
}
