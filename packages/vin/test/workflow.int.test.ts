// The VIN request workflow on the project database (`${DATABASE_URL_TEST}_vin`): the /vin form
// (users, consents, vin_requests, outbox), the master's answer (preview on the Rossko fixtures),
// «Отправить клиенту» (proposal cart, token, 7 days, outbox vin_proposal), /p/<token>, the copy
// into the client's cart, converted and closed.
import { randomBytes } from 'node:crypto';
import {
  and,
  cartItems,
  carts,
  consents,
  createDb,
  documentVersions,
  eq,
  orders,
  outbox,
  sql,
  staff,
  users,
  vinRequests,
  type Db,
} from '@detaly/db';
import {
  DEFAULT_EXCLUDED_RULES,
  PROPOSAL_TTL_DAYS,
  type EtaSettings,
  type MarkupRule,
  type VinPreview,
} from '@detaly/domain';
import { createFixtureCaller, createRosskoClient, createUnlimitedLimiter } from '@detaly/rossko';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  closeVinRequest,
  copyProposalToCart,
  createVinRequest,
  loadProposal,
  loadVinRequestForStaff,
  markVinConverted,
  newVinRequestId,
  previewVinAnswer,
  saveVinPreview,
  sendVinProposal,
  takeVinRequest,
  VinRequestInputError,
  type CreateVinRequestInput,
  type VinWorkflowDeps,
} from '../src';

const DB_URL = inject('vinDatabaseUrl');

const RULES: MarkupRule[] = [{ fromKop: 0, toKop: null, localBp: 2800, orderBp: 2800 }];
const ETA: EtaSettings = { bufferDays: 1, invoiceLagDays: 0, prepayInvoice: false };
const T0 = new Date('2026-10-05T07:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const SHA = 'a'.repeat(64);
const PHONE_DIGITS = '9161237788';

const rossko = createRosskoClient({
  caller: createFixtureCaller(),
  key1: 'k1',
  key2: 'k2',
  localStockIds: ['ORB1'],
  limiter: createUnlimitedLimiter(),
  allowCheckout: false,
});

function previewOf(text: string, now = T0): Promise<VinPreview> {
  return previewVinAnswer({
    text,
    search: async (article) => (await rossko.search(article)).offers,
    markupRules: RULES,
    excludedRules: DEFAULT_EXCLUDED_RULES,
    eta: ETA,
    now,
  });
}

/** A random valid mobile number, so tests do not share users. */
function randomPhone(): string {
  return `+79${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

describe.skipIf(!DB_URL)('VIN request workflow', () => {
  let db: Db;
  let documentVersionId: string;
  let staffId: string;
  let nudges = 0;
  let deps: VinWorkflowDeps;

  function formInput(overrides: Partial<CreateVinRequestInput> = {}): CreateVinRequestInput {
    return {
      vin: 'xta 21099-0 4345 6789',
      carText: 'ВАЗ 2109',
      needText: `Масляный фильтр и колодки, мой телефон 8 ${PHONE_DIGITS}`,
      phone: `8 ${PHONE_DIGITS}`,
      channel: 'sms',
      photoKeys: [],
      consent: { documentVersionId, textSha256: SHA, ip: '203.0.113.7', userAgent: 'test' },
      requestKey: uuidv7(),
      now: T0,
      ...overrides,
    };
  }

  async function newRequest(overrides: Partial<CreateVinRequestInput> = {}): Promise<string> {
    const { vinRequestId } = await createVinRequest(
      db,
      formInput({ phone: randomPhone(), ...overrides }),
    );
    return vinRequestId;
  }

  async function answer(id: string, text: string): Promise<VinPreview> {
    const preview = await previewOf(text);
    const saved = await saveVinPreview(db, { id, answerText: text, preview, staffId, now: T0 });
    expect(saved).toEqual({ ok: true });
    return preview;
  }

  async function clientCart(): Promise<string> {
    const [cart] = await db
      .insert(carts)
      .values({ anonToken: randomBytes(32).toString('base64url'), status: 'active' })
      .returning({ id: carts.id });
    return (cart as { id: string }).id;
  }

  beforeAll(async () => {
    db = createDb(DB_URL as string, { max: 4 });
    const [doc] = await db.select({ id: documentVersions.id }).from(documentVersions).limit(1);
    if (!doc) throw new Error('seeded document_versions expected');
    documentVersionId = doc.id;
    const [seller] = await db
      .insert(staff)
      .values({
        name: 'Продавец',
        role: 'seller',
        tgUserId: 700_000_000 + Math.floor(Math.random() * 1e6),
      })
      .returning({ id: staff.id });
    staffId = (seller as { id: string }).id;
    deps = { db, now: () => T0, nudge: () => (nudges += 1) };
  });

  afterAll(async () => {
    await db?.close();
  });

  it('the form: user without a name, consent, request with 2 photos, sellers card and vin_received', async () => {
    const id = newVinRequestId();
    const photoKeys = [`vin/${id}/${uuidv7()}.jpg`, `vin/${id}/${uuidv7()}.jpg`];
    const phone = randomPhone();
    const result = await createVinRequest(
      db,
      formInput({ id, phone, photoKeys, channel: 'telegram' }),
    );
    expect(result).toMatchObject({ vinRequestId: id, duplicate: false });

    const [row] = await db.select().from(vinRequests).where(eq(vinRequests.id, id));
    expect(row).toMatchObject({
      status: 'new',
      vin: 'XTA21099043456789',
      carText: 'ВАЗ 2109',
      phone,
      channel: 'telegram',
      photos: photoKeys,
      userId: result.userId,
      resolver: 'manual',
      proposalCount: 0,
    });
    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(user).toMatchObject({ phone, name: null });
    const consentRows = await db.select().from(consents).where(eq(consents.vinRequestId, id));
    expect(consentRows).toHaveLength(1);
    expect(consentRows[0]).toMatchObject({
      userId: result.userId,
      kind: 'pd',
      channel: 'web',
      textSha256: SHA,
      documentVersionId,
      orderId: null,
      ip: '203.0.113.7',
    });

    const jobs = await db
      .select()
      .from(outbox)
      .where(sql`${outbox.jobId} like ${`vin:${id}:%`}`)
      .orderBy(outbox.jobId);
    expect(jobs.map((j) => [j.queue, j.name, j.jobId])).toEqual([
      ['notify', 'vin', `vin:${id}:card:0`],
      ['notify', 'vin', `vin:${id}:vin_received:0`],
    ]);
    expect(jobs[0]?.data).toEqual({
      vinRequestId: id,
      audience: 'sellers',
      key: `vin:${id}:card:0`,
    });
    expect(jobs[1]?.data).toEqual({
      vinRequestId: id,
      audience: 'client',
      template: 'vin_received',
      key: `vin:${id}:vin_received:0`,
      n: 0,
    });
    // No phone in job data.
    expect(JSON.stringify(jobs.map((j) => j.data))).not.toContain(phone.slice(2));
  });

  it('a repeated request_key returns the first request and writes nothing', async () => {
    const phone = randomPhone();
    const input = formInput({ phone });
    const first = await createVinRequest(db, input);
    const second = await createVinRequest(db, { ...input, id: newVinRequestId() });
    expect(second).toEqual({ ...first, duplicate: true });
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(vinRequests)
      .where(eq(vinRequests.phone, phone));
    expect(rows[0]?.n).toBe(1);
    // Concurrent submits of one form: one request.
    const racing = formInput({ phone: randomPhone() });
    const both = await Promise.all([createVinRequest(db, racing), createVinRequest(db, racing)]);
    expect(both[0].vinRequestId).toBe(both[1].vinRequestId);
    expect(both.map((r) => r.duplicate).sort()).toEqual([false, true]);
    // The same key with another phone is refused.
    await expect(createVinRequest(db, { ...input, phone: randomPhone() })).rejects.toMatchObject({
      field: 'request_key',
    });
  });

  it('rejects bad input by field, without echoing values', async () => {
    const id = newVinRequestId();
    const cases: [Partial<CreateVinRequestInput>, string][] = [
      [{ vin: 'XTA21O99043456789' }, 'vin'],
      [{ needText: 'a' }, 'need_text'],
      [{ carText: 'x'.repeat(201) }, 'car_text'],
      [{ phone: '8 3532 12-34-56' }, 'phone'],
      [{ channel: 'max' as never }, 'channel'],
      [{ id, photoKeys: [`vin/${newVinRequestId()}/${uuidv7()}.jpg`] }, 'photos'],
      [{ id, photoKeys: Array.from({ length: 4 }, () => `vin/${id}/${uuidv7()}.jpg`) }, 'photos'],
      [{ photoKeys: [`vin/${id}/${uuidv7()}.jpg`] }, 'photos'],
      [{ consent: { documentVersionId, textSha256: 'x', ip: null, userAgent: null } }, 'consent'],
      [
        { consent: { documentVersionId: uuidv7(), textSha256: SHA, ip: null, userAgent: null } },
        'consent',
      ],
      [{ requestKey: 'not-a-uuid' }, 'request_key'],
    ];
    for (const [overrides, field] of cases) {
      const error = await createVinRequest(db, formInput(overrides)).catch((e: unknown) => e);
      expect(error, field).toBeInstanceOf(VinRequestInputError);
      expect((error as VinRequestInputError).field).toBe(field);
      expect((error as Error).message).not.toContain(PHONE_DIGITS);
    }
  });

  it('take, an answer with a typo is not sendable, the fixed answer becomes a 7-day proposal', async () => {
    const id = await newRequest();
    expect(await sendVinProposal(deps, { id, staffId })).toEqual({ ok: false, reason: 'empty' });
    expect(await takeVinRequest(db, { id, staffId, now: T0 })).toEqual({
      ok: true,
      status: 'in_work',
    });

    const typo = await answer(id, 'MANN W9142X 1\nKnecht OC90 2');
    expect(typo.errorCount).toBe(1);
    expect(await sendVinProposal(deps, { id, staffId })).toEqual({
      ok: false,
      reason: 'has_errors',
    });
    expect(await db.select().from(carts).where(eq(carts.vinRequestId, id))).toHaveLength(0);

    const fixed = await answer(
      id,
      '> Оригинал, хватит на ТО\nMANN W914/2 1\nKnecht OC90 2 # запас',
    );
    expect(fixed).toMatchObject({ okCount: 2, errorCount: 0 });
    const nudgesBefore = nudges;
    const sent = await sendVinProposal(deps, { id, staffId });
    if (!sent.ok) throw new Error(`send refused: ${sent.reason}`);
    expect(sent.proposalToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(sent.n).toBe(1);
    expect(sent.expiresAt.getTime() - T0.getTime()).toBe(PROPOSAL_TTL_DAYS * DAY_MS);
    expect(nudges).toBe(nudgesBefore + 1);

    const [cart] = await db.select().from(carts).where(eq(carts.id, sent.cartId));
    expect(cart).toMatchObject({
      status: 'active',
      proposalToken: sent.proposalToken,
      sellerNote: 'Оригинал, хватит на ТО',
      vinRequestId: id,
      anonToken: null,
    });
    expect(cart?.proposalExpiresAt?.getTime()).toBe(sent.expiresAt.getTime());
    const items = await db
      .select()
      .from(cartItems)
      .where(eq(cartItems.cartId, sent.cartId))
      .orderBy(cartItems.id);
    expect(items.map((i) => [i.offerKey, i.qty, i.priceClientKop])).toEqual(
      fixed.lines.map((l) => (l.status === 'ok' ? [l.offerKey, l.qty, l.priceClientKop] : null)),
    );

    const [request] = await db.select().from(vinRequests).where(eq(vinRequests.id, id));
    expect(request).toMatchObject({
      status: 'offered',
      proposalCartId: sent.cartId,
      proposalCount: 1,
      assignedStaffId: staffId,
    });
    expect(request?.answeredAt?.getTime()).toBe(T0.getTime());
    const [job] = await db
      .select()
      .from(outbox)
      .where(eq(outbox.jobId, `vin:${id}:vin_proposal:1`));
    expect(job?.data).toEqual({
      vinRequestId: id,
      audience: 'client',
      template: 'vin_proposal',
      key: `vin:${id}:vin_proposal:1`,
      n: 1,
    });

    // /p/<token>
    const view = await loadProposal(db, sent.proposalToken, new Date(T0.getTime() + DAY_MS));
    expect(view).toMatchObject({
      cartId: sent.cartId,
      vinRequestId: id,
      comment: 'Оригинал, хватит на ТО',
      expired: false,
      superseded: false,
      totalKop: fixed.totalKop,
    });
    expect(view?.lines).toHaveLength(2);
    const late = await loadProposal(db, sent.proposalToken, sent.expiresAt);
    expect(late?.expired).toBe(true);
    expect(await loadProposal(db, 'x'.repeat(32), T0)).toBeNull();
    expect(await loadProposal(db, "' or 1=1 --", T0)).toBeNull();
  });

  it('«Исправить» and send again: a new proposal, the old one is abandoned and expired', async () => {
    const id = await newRequest();
    await answer(id, 'MANN W914/2 1');
    const first = await sendVinProposal(deps, { id, staffId: null });
    if (!first.ok) throw new Error('first send refused');
    expect(first.duplicate).toBe(false);
    // A double click (or the same answer saved again) does not message the client twice.
    const nudgesBefore = nudges;
    const [again, twice] = await Promise.all([
      sendVinProposal(deps, { id, staffId: null }),
      sendVinProposal(deps, { id, staffId: null }),
    ]);
    for (const repeat of [again, twice]) {
      expect(repeat).toMatchObject({
        ok: true,
        duplicate: true,
        n: 1,
        proposalToken: first.proposalToken,
        cartId: first.cartId,
      });
    }
    expect(nudges).toBe(nudgesBefore);
    await answer(id, 'MANN W914/2 1');
    expect(await sendVinProposal(deps, { id, staffId: null })).toMatchObject({ duplicate: true });
    await answer(id, 'MANN W914/2 2');
    const second = await sendVinProposal(deps, { id, staffId: null });
    if (!second.ok) throw new Error('second send refused');
    expect(second.n).toBe(2);
    expect(second.proposalToken).not.toBe(first.proposalToken);

    const old = await loadProposal(db, first.proposalToken, T0);
    expect(old).toMatchObject({ expired: true, superseded: true });
    const [oldCart] = await db.select().from(carts).where(eq(carts.id, first.cartId));
    expect(oldCart?.status).toBe('abandoned');
    expect(await loadProposal(db, second.proposalToken, T0)).toMatchObject({ expired: false });
    // The same answer once the proposal expired: a fresh proposal with a new 7-day term.
    const later = { ...deps, now: () => second.expiresAt };
    const refreshed = await sendVinProposal(later, { id, staffId: null });
    expect(refreshed).toMatchObject({ ok: true, duplicate: false, n: 3 });
    const keys = await db
      .select({ key: outbox.jobId })
      .from(outbox)
      .where(sql`${outbox.jobId} like ${`vin:${id}:vin_proposal:%`}`)
      .orderBy(outbox.jobId);
    expect(keys.map((k) => k.key)).toEqual([
      `vin:${id}:vin_proposal:1`,
      `vin:${id}:vin_proposal:2`,
      `vin:${id}:vin_proposal:3`,
    ]);
    // The old proposal cannot be copied into a cart any more.
    expect(
      await db.transaction((tx) =>
        copyProposalToCart(tx, { proposalCartId: first.cartId, targetCartId: first.cartId }),
      ),
    ).toEqual({ ok: false, reason: 'not_found' });
    const target = await clientCart();
    expect(
      await db.transaction((tx) =>
        copyProposalToCart(tx, { proposalCartId: first.cartId, targetCartId: target, now: T0 }),
      ),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('copyProposalToCart: the same offer gets the proposal quantity, the cart remembers the request', async () => {
    const id = await newRequest();
    const preview = await answer(id, 'Knecht OC90 2\nMANN W914/2 1');
    const sent = await sendVinProposal(deps, { id, staffId });
    if (!sent.ok) throw new Error('send refused');
    const ocLine = preview.lines[0];
    if (ocLine?.status !== 'ok') throw new Error('ok line expected');

    // The client already has 5 × Knecht OC 90 (ORB1) and something else in the cart.
    const target = await clientCart();
    const [proposalOc] = await db
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.cartId, sent.cartId), eq(cartItems.offerKey, ocLine.offerKey)));
    if (!proposalOc) throw new Error('proposal line expected');
    const { id: _ignored, cartId: _cart, ...ocValues } = proposalOc;
    await db.insert(cartItems).values({ ...ocValues, cartId: target, qty: 5 });
    const gdb = await previewOf('TRW GDB1330 1');
    const gdbLine = gdb.lines[0];
    if (gdbLine?.status !== 'ok') throw new Error('ok line expected');
    await db.insert(cartItems).values({
      cartId: target,
      offerKey: gdbLine.offerKey,
      searchArticleNorm: gdbLine.searchArticleNorm,
      brand: gdbLine.brand,
      article: gdbLine.article,
      name: gdbLine.name,
      qty: 1,
      stockId: gdbLine.offer.stock.stockId,
      isLocal: gdbLine.isLocal,
      etaDate: gdbLine.etaDate,
      priceSupplierKop: gdbLine.priceSupplierKop,
      priceClientKop: gdbLine.priceClientKop,
      markupBp: gdbLine.markupBp,
      offerSnapshot: gdbLine.offer,
      fetchedAt: T0,
    });

    const copied = await db.transaction((tx) =>
      copyProposalToCart(tx, { proposalCartId: sent.cartId, targetCartId: target, now: T0 }),
    );
    expect(copied).toEqual({ ok: true, inserted: 1, updated: 1, vinRequestId: id });
    const lines = await db.select().from(cartItems).where(eq(cartItems.cartId, target));
    expect(Object.fromEntries(lines.map((l) => [l.offerKey, l.qty]))).toEqual({
      'OC90:Knecht:ORB1': 2,
      'W9142:MANN-FILTER:MSK7': 1,
      [gdbLine.offerKey]: 1,
    });
    const [targetCart] = await db.select().from(carts).where(eq(carts.id, target));
    expect(targetCart?.vinRequestId).toBe(id);
    // Taking it again changes nothing but the quantities (idempotent).
    const again = await db.transaction((tx) =>
      copyProposalToCart(tx, { proposalCartId: sent.cartId, targetCartId: target, now: T0 }),
    );
    expect(again).toEqual({ ok: true, inserted: 0, updated: 2, vinRequestId: id });
    // The proposal itself is untouched.
    expect(await db.select().from(cartItems).where(eq(cartItems.cartId, sent.cartId))).toHaveLength(
      2,
    );
    // Past the 7 days: expired.
    const expired = await db.transaction((tx) =>
      copyProposalToCart(tx, {
        proposalCartId: sent.cartId,
        targetCartId: target,
        now: sent.expiresAt,
      }),
    );
    expect(expired).toEqual({ ok: false, reason: 'expired' });
    // A proposal cart is never a target.
    const other = await newRequest();
    await answer(other, 'MANN W914/2 1');
    const otherSent = await sendVinProposal(deps, { id: other, staffId });
    if (!otherSent.ok) throw new Error('send refused');
    expect(
      await db.transaction((tx) =>
        copyProposalToCart(tx, { proposalCartId: sent.cartId, targetCartId: otherSent.cartId }),
      ),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  it('markVinConverted in the checkout transaction: converted once, the order is linked', async () => {
    const id = await newRequest();
    await answer(id, 'MANN W914/2 1');
    const sent = await sendVinProposal(deps, { id, staffId });
    expect(sent.ok).toBe(true);
    const [request] = await db.select().from(vinRequests).where(eq(vinRequests.id, id));
    const [order] = await db
      .insert(orders)
      .values({
        userId: request?.userId as string,
        accessToken: randomBytes(32).toString('base64url'),
        status: 'awaiting_payment',
        paymentScheme: 'prepay',
        subtotalKop: 79_800,
        courierFeeKop: 0,
        totalKop: 79_800,
        itemsHash: 'test',
      })
      .returning({ id: orders.id });
    const orderId = (order as { id: string }).id;

    const first = await db.transaction((tx) =>
      markVinConverted(tx, { vinRequestId: id, orderId, now: T0 }),
    );
    expect(first).toEqual({ converted: true });
    const [after] = await db.select().from(vinRequests).where(eq(vinRequests.id, id));
    expect(after?.status).toBe('converted');
    const [linked] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(linked?.vinRequestId).toBe(id);
    expect(
      await db.transaction((tx) => markVinConverted(tx, { vinRequestId: id, orderId, now: T0 })),
    ).toEqual({ converted: false });

    // A converted request is no longer worked on.
    expect(await takeVinRequest(db, { id, staffId })).toEqual({ ok: false, reason: 'converted' });
    expect(await sendVinProposal(deps, { id, staffId })).toEqual({ ok: false, reason: 'closed' });
    expect(await closeVinRequest(db, { id, reason: 'дубль' })).toEqual({
      ok: false,
      reason: 'converted',
    });
  });

  it('closeVinRequest: closed, the live proposal stops selling, further actions refused', async () => {
    const id = await newRequest();
    await answer(id, 'MANN W914/2 1');
    const sent = await sendVinProposal(deps, { id, staffId });
    if (!sent.ok) throw new Error('send refused');
    expect(await closeVinRequest(db, { id, reason: '  клиент купил сам  ', now: T0 })).toEqual({
      ok: true,
    });
    expect(await closeVinRequest(db, { id, reason: null })).toEqual({ ok: true });
    const [row] = await db.select().from(vinRequests).where(eq(vinRequests.id, id));
    expect(row).toMatchObject({ status: 'closed', closeReason: 'клиент купил сам' });
    expect(row?.closedAt?.getTime()).toBe(T0.getTime());
    expect(await loadProposal(db, sent.proposalToken, T0)).toMatchObject({ expired: true });
    expect(await takeVinRequest(db, { id, staffId })).toEqual({ ok: false, reason: 'closed' });
    expect(
      await saveVinPreview(db, { id, answerText: 'x', preview: await previewOf('MANN W914/2') }),
    ).toEqual({ ok: false, reason: 'closed' });
    expect(await sendVinProposal(deps, { id, staffId })).toEqual({ ok: false, reason: 'closed' });
    expect(await takeVinRequest(db, { id: 'not-a-uuid', staffId })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await closeVinRequest(db, { id: uuidv7(), reason: null })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('loadVinRequestForStaff: masked phone and digit runs for the bot, everything for the admin', async () => {
    const phone = `+7${PHONE_DIGITS}`;
    const id = newVinRequestId();
    const photo = `vin/${id}/${uuidv7()}.jpg`;
    await createVinRequest(db, formInput({ id, phone, photoKeys: [photo] }));
    await answer(id, 'MANN W914/2 1');
    const sent = await sendVinProposal(deps, { id, staffId });
    if (!sent.ok) throw new Error('send refused');

    const bot = await loadVinRequestForStaff(db, id);
    expect(bot).toMatchObject({
      id,
      status: 'offered',
      vin: 'XTA21099043456789',
      phone: '•••7788',
      photos: [photo],
      photosDeleted: false,
      proposalCount: 1,
      proposalCartId: sent.cartId,
      proposalToken: null,
    });
    expect(bot?.needText).toBe('Масляный фильтр и колодки, мой телефон •••');
    expect(JSON.stringify(bot)).not.toContain(PHONE_DIGITS.slice(-7));
    expect(JSON.stringify(bot)).not.toContain(sent.proposalToken);

    const admin = await loadVinRequestForStaff(db, id, { revealPd: true });
    expect(admin).toMatchObject({ phone, proposalToken: sent.proposalToken });
    expect(admin?.needText).toContain(PHONE_DIGITS);
    expect(admin?.proposalExpiresAt?.getTime()).toBe(sent.expiresAt.getTime());
    expect(await loadVinRequestForStaff(db, uuidv7())).toBeNull();
    expect(await loadVinRequestForStaff(db, 'nope')).toBeNull();
  });

  it('loadVinRequestForStaff: registration plates and e-mails are masked for the bot', async () => {
    const id = newVinRequestId();
    await createVinRequest(
      db,
      formInput({
        id,
        phone: randomPhone(),
        carText: 'Гранта А123ВС56',
        needText: 'Колодки, машина а 123 вс 156, пишите ivan@example.ru',
      }),
    );
    const bot = await loadVinRequestForStaff(db, id);
    expect(bot?.carText).toBe('Гранта •••');
    expect(bot?.needText).toBe('Колодки, машина •••, пишите •••');
    const admin = await loadVinRequestForStaff(db, id, { revealPd: true });
    expect(admin?.carText).toBe('Гранта А123ВС56');
  });
});
