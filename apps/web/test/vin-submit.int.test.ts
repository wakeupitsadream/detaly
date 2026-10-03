// POST /api/vin (server/vin/submit-handler.ts, decision С12) against local PG with a memory
// FileStore: the gate, Origin, honeypot, field errors in both answer modes (JSON for the form
// with JavaScript, 303 back with codes without it), photo limits, the rows written (user,
// consent with vin_request_id, the request, two notify/vin outbox rows), the link token for
// Telegram, idempotency by request key, and logs without the phone or the full VIN.
import {
  and,
  consents,
  createDb,
  eq,
  linkTokens,
  outbox,
  users,
  vinRequests,
  type Db,
} from '@detaly/db';
import { createMemoryFileStore, type MemoryFileStore } from '@detaly/files';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCheckoutGate, type CheckoutGate } from '@/server/checkout-gate';
import { uuidV7 } from '@/server/checkout/uuid';
import { VIN_FORM_MESSAGES } from '@/server/vin/form';
import { handleVinSubmit, type VinSubmitDeps } from '@/server/vin/submit-handler';
import { intEnv, webDatabaseUrl } from './helpers';

const BASE = 'http://127.0.0.1:3100';
const VIN = 'XTA210990Y1234567';

let db: Db;
let files: MemoryFileStore;
let logs: unknown[] = [];
let nudges = 0;
const env = intEnv({
  APP_BASE_URL: BASE,
  RKN_NOTICE_NUMBER: 'TEST-1',
  TG_CLIENT_BOT_USERNAME: 'detaly_test_bot',
  TRUSTED_IP_HEADER: 'x-real-ip',
});

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 4 });
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  files = createMemoryFileStore();
  logs = [];
  nudges = 0;
});

function deps(overrides: Partial<VinSubmitDeps> = {}): VinSubmitDeps {
  const log = (level: string) => (details: Record<string, unknown>, message: string) => {
    logs.push([level, details, message]);
  };
  return {
    db,
    env,
    files,
    gate: () => getCheckoutGate({ env, db }),
    logger: { info: log('info'), warn: log('warn'), error: log('error') },
    nudge: () => {
      nudges += 1;
    },
    ...overrides,
  };
}

function phone(): { typed: string; e164: string } {
  const digits = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  return {
    typed: `8 (9${digits.slice(0, 2)}) ${digits.slice(2, 5)}-${digits.slice(5, 7)}-${digits.slice(7)}`,
    e164: `+79${digits}`,
  };
}

async function jpeg(color = '#cc3333'): Promise<Blob> {
  const buffer = await sharp({ create: { width: 40, height: 30, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
  return new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' });
}

async function consentId(): Promise<string> {
  const gate: CheckoutGate = await getCheckoutGate({ env, db });
  if (!gate.open) throw new Error('gate closed in the test env');
  return gate.docs.consentPd.id;
}

interface FormSpec {
  fields?: Record<string, string | null>;
  photos?: number;
  json?: boolean;
  headers?: Record<string, string>;
}

async function post(spec: FormSpec = {}) {
  const form = new FormData();
  const p = phone();
  const base: Record<string, string> = {
    vin: VIN.toLowerCase().replace(/(.{3})/, '$1 '),
    car: 'Lada Granta 2019',
    need: 'Передние тормозные колодки',
    phone: p.typed,
    channel: 'telegram',
    consentPd: 'on',
    consentPdVersionId: await consentId(),
    requestKey: uuidV7(),
    website: '',
  };
  for (const [name, value] of Object.entries({ ...base, ...spec.fields })) {
    if (value !== null && value !== undefined) form.set(name, value);
  }
  for (let i = 0; i < (spec.photos ?? 0); i += 1) {
    form.append('photos', await jpeg(i % 2 === 0 ? '#cc3333' : '#3333cc'), `p${i}.jpg`);
  }
  const headers: Record<string, string> = {
    origin: BASE,
    'user-agent': 'Mozilla/5.0 (vin test)',
    'x-real-ip': '10.1.2.3',
    ...(spec.json === false ? {} : { accept: 'application/json' }),
    ...spec.headers,
  };
  const request = new Request(`${BASE}/api/vin`, { method: 'POST', headers, body: form });
  return { request, phone: p, fields: { ...base, ...spec.fields } };
}

async function requestsOf(e164: string) {
  return db.select().from(vinRequests).where(eq(vinRequests.phone, e164));
}

describe('POST /api/vin: refusals', () => {
  it('a closed gate (no RKN notice number) answers 403 and writes nothing', async () => {
    const closedEnv = intEnv({ APP_BASE_URL: BASE, RKN_NOTICE_NUMBER: undefined });
    const { request, phone: p } = await post();
    const response = await handleVinSubmit(
      request,
      deps({ env: closedEnv, gate: () => getCheckoutGate({ env: closedEnv, db }) }),
    );
    expect(response.status).toBe(403);
    expect(await requestsOf(p.e164)).toEqual([]);
  });

  it('a foreign Origin answers 403', async () => {
    const { request } = await post({ headers: { origin: 'https://evil.example' } });
    const response = await handleVinSubmit(request, deps());
    expect(response.status).toBe(403);
  });

  it('a VIN with O answers 422 with the O/0 hint, nothing is written', async () => {
    const { request, phone: p } = await post({ fields: { vin: 'XTA2109O0Y1234567' } });
    const response = await handleVinSubmit(request, deps());
    expect(response.status).toBe(422);
    const body = (await response.json()) as { fields: Record<string, string> };
    expect(body.fields.vin).toBe(VIN_FORM_MESSAGES.vin_oiq);
    expect(await requestsOf(p.e164)).toEqual([]);
  });

  it('without the PD consent: 422 with the consent field, no rows, no files', async () => {
    const { request, phone: p } = await post({ fields: { consentPd: null }, photos: 1 });
    const response = await handleVinSubmit(request, deps());
    expect(response.status).toBe(422);
    const body = (await response.json()) as { fields: Record<string, string> };
    expect(body.fields.consent).toBe(VIN_FORM_MESSAGES.consent);
    expect(await requestsOf(p.e164)).toEqual([]);
    expect(await db.select().from(users).where(eq(users.phone, p.e164))).toEqual([]);
    expect(files.keys()).toEqual([]);
  });

  it('every field error at once; without JavaScript a 303 back with codes only', async () => {
    const { request, fields } = await post({
      json: false,
      fields: { vin: 'abc', need: 'x', phone: '123', channel: 'max' },
    });
    const response = await handleVinSubmit(request, deps());
    expect(response.status).toBe(303);
    const location = response.headers.get('location') ?? '';
    expect(location).toBe('/vin?e=vin,need,phone,channel#vin-form');
    // Codes, never what was typed.
    expect(location).not.toContain(fields.phone);
  });

  it('four photos answer 413 and nothing is stored', async () => {
    const { request, phone: p } = await post({ photos: 4 });
    const response = await handleVinSubmit(request, deps());
    expect(response.status).toBe(413);
    expect(await requestsOf(p.e164)).toEqual([]);
    expect(files.keys()).toEqual([]);
  });

  it('a filled honeypot answers 400', async () => {
    const { request, phone: p } = await post({ fields: { website: 'http://spam.example' } });
    const response = await handleVinSubmit(request, deps());
    expect(response.status).toBe(400);
    expect(await requestsOf(p.e164)).toEqual([]);
  });

  it('a consent text other than the one served now answers 409', async () => {
    const { request, phone: p } = await post({ fields: { consentPdVersionId: uuidV7() } });
    const response = await handleVinSubmit(request, deps());
    expect(response.status).toBe(409);
    expect(await requestsOf(p.e164)).toEqual([]);
  });

  it('photos are refused while photo storage is off', async () => {
    const off = { ...files, kind: 'none' as const };
    const { request } = await post({ photos: 1 });
    const response = await handleVinSubmit(request, deps({ files: off }));
    expect(response.status).toBe(413);
  });
});

describe('POST /api/vin: success', () => {
  it('two photos: the request, consent, files and outbox; Telegram -> /vin/sent/<link token>', async () => {
    const { request, phone: p } = await post({ photos: 2 });
    const response = await handleVinSubmit(request, deps());
    expect(response.status).toBe(200);
    const { location } = (await response.json()) as { location: string };
    expect(location).toMatch(/^\/vin\/sent\/[A-Za-z0-9_-]{32}$/);

    const [row] = await requestsOf(p.e164);
    expect(row).toMatchObject({
      vin: VIN,
      carText: 'Lada Granta 2019',
      needText: 'Передние тормозные колодки',
      status: 'new',
      channel: 'telegram',
      resolver: 'manual',
    });
    expect(row?.photos).toHaveLength(2);
    expect(files.keys().sort()).toEqual([...(row?.photos ?? [])].sort());
    for (const key of row?.photos ?? []) {
      expect(key).toMatch(new RegExp(`^vin/${row?.id}/[0-9a-f-]{36}\\.jpg$`));
      const stored = await files.get(key);
      expect((await sharp(stored?.bytes).metadata()).format).toBe('jpeg');
    }

    const [consent] = await db
      .select()
      .from(consents)
      .where(eq(consents.vinRequestId, row?.id ?? ''));
    expect(consent).toMatchObject({
      kind: 'pd',
      channel: 'web',
      documentVersionId: await consentId(),
      ip: '10.1.2.3',
      userId: row?.userId,
    });
    const jobs = await db
      .select()
      .from(outbox)
      .where(and(eq(outbox.queue, 'notify'), eq(outbox.name, 'vin')));
    const mine = jobs.filter(
      (job) => (job.data as { vinRequestId?: string }).vinRequestId === row?.id,
    );
    expect(mine.map((job) => job.jobId).sort()).toEqual(
      [`vin:${row?.id}:card:0`, `vin:${row?.id}:vin_received:0`].sort(),
    );
    expect(nudges).toBe(1);

    const token = location.split('/').pop() ?? '';
    const [link] = await db.select().from(linkTokens).where(eq(linkTokens.token, token));
    expect(link).toMatchObject({
      userId: row?.userId,
      orderId: null,
      usedAt: null,
      channel: 'telegram',
    });

    // Logs: the request id and the masked VIN only.
    const text = JSON.stringify(logs);
    expect(text).toContain(row?.id ?? 'missing');
    expect(text).not.toContain(VIN);
    expect(text).not.toContain(p.e164);
    expect(text).not.toContain(p.e164.slice(2));
    expect(text).not.toContain(token);
  });

  it('SMS (or no bot username) -> /vin/sent; without JavaScript a 303', async () => {
    const { request } = await post({ json: false, fields: { channel: 'sms' } });
    const response = await handleVinSubmit(request, deps());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/vin/sent');

    const noBot = intEnv({ APP_BASE_URL: BASE, RKN_NOTICE_NUMBER: 'TEST-1' });
    const second = await post({ fields: { channel: 'telegram' } });
    const answer = await handleVinSubmit(second.request, deps({ env: noBot }));
    expect(((await answer.json()) as { location: string }).location).toBe('/vin/sent');
  });

  it('the same request key twice: one request, the second upload is dropped', async () => {
    const requestKey = uuidV7();
    const first = await post({ photos: 1, fields: { requestKey } });
    const p = first.phone;
    expect((await handleVinSubmit(first.request, deps())).status).toBe(200);
    const again = await post({ photos: 1, fields: { requestKey, phone: p.typed } });
    expect((await handleVinSubmit(again.request, deps())).status).toBe(200);
    const rows = await requestsOf(p.e164);
    expect(rows).toHaveLength(1);
    expect(files.keys()).toEqual(rows[0]?.photos ?? []);
    expect(nudges).toBe(1);
  });
});
