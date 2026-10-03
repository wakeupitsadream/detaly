// Claims (decisions С7–С11; section 5.3; Verification 1C V7/V8): opening through claim_opened,
// «Принял возврат» with a photo, the decision (refund / replace / reject) and its money, the
// completion timer held by an open claim, a delay before the handover, compensation, photos.
import {
  and,
  claims,
  eq,
  orderPhotos,
  orders,
  outbox,
  receipts,
  refunds,
  sql,
  supplierOrderItems,
  supplierOrders,
  supplierReturns,
  type Db,
} from '@detaly/db';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptClaimReturn,
  addOrderPhoto,
  applyRefundObject,
  applyTransition,
  bindMessenger,
  closeClaim,
  decideClaim,
  DELAY_WHOLE_ORDER_ONLY,
  loadClaimsView,
  loadOrderPhotos,
  loadStaffActions1C,
  openClaim,
  orderClaimReplacement,
  performStaffAction,
  recordClaimCompensation,
  REPLACEMENT_NOT_ORDERED,
  type ActorRef,
  type EngineDeps,
  type StaffRef,
} from '../src';
import {
  assertNoPhone,
  DB_URL,
  eventsOf,
  fileKey,
  itemRows,
  makeDeps,
  openDb,
  orderRow,
  outboxOf,
  providerRefund,
  seedOrder,
  setHanded,
  T0,
  testClock,
  type SeededOrder,
  type SeedItem,
  type TestClock,
} from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const seller: StaffRef = { id: null, role: 'seller', via: 'bot' };
const owner: StaffRef = { id: null, role: 'owner', via: 'admin' };
const CLIENT_TEXT = 'Течёт по корпусу, звоните 8 912 345-67-89';

describe.skipIf(!DB_URL)('claims', () => {
  let db: Db;
  let clock: TestClock;
  let deps: EngineDeps;

  beforeAll(() => {
    db = openDb();
    clock = testClock();
    deps = makeDeps(db, { clock });
  });
  beforeEach(() => {
    clock.now = T0;
  });
  afterAll(async () => {
    await db?.close();
  });

  /** A prepay order handed at T0 (offset receipt succeeded), the clock one day later. */
  async function handedOrder(items?: SeedItem[]) {
    const seeded = await seedOrder(db, {
      status: 'handed',
      clientArrived: true,
      offset: 'succeeded',
      ...(items ? { items } : {}),
    });
    await setHanded(db, seeded.orderId, T0);
    clock.now = new Date(T0.getTime() + DAY);
    return seeded;
  }

  function clientOf(seeded: SeededOrder): ActorRef {
    return { type: 'client', id: seeded.userId };
  }

  async function open(
    seeded: SeededOrder,
    overrides: Partial<Parameters<typeof openClaim>[1]> = {},
  ) {
    const result = await openClaim(deps, {
      orderId: seeded.orderId,
      kind: 'defect',
      text: CLIENT_TEXT,
      photoKeys: [fileKey('claim', seeded.orderId), fileKey('claim', seeded.orderId)],
      via: 'web',
      requestKey: uuidv7(),
      actor: clientOf(seeded),
      ...overrides,
    });
    if (!result.ok) throw new Error(`openClaim failed: ${result.reason} ${result.message}`);
    return result;
  }

  async function claimRow(id: string) {
    const [row] = await db.select().from(claims).where(eq(claims.id, id));
    if (!row) throw new Error('claim not found');
    return row;
  }

  async function refundsOf(orderId: string) {
    return db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(refunds.createdAt);
  }

  async function succeedRefund(seeded: SeededOrder, refundId: string, amountKop: number) {
    await db
      .update(refunds)
      .set({ providerRefundId: `rf-${refundId}` })
      .where(eq(refunds.id, refundId));
    return applyRefundObject(
      deps,
      providerRefund(`rf-${refundId}`, { paymentId: seeded.providerPaymentId!, amountKop }),
      { source: 'webhook' },
    );
  }

  describe('opening', () => {
    it('writes the claims row through claim_opened: deadline +10 days, notifications, no PD in the journal', async () => {
      const seeded = await handedOrder();
      const opened = await open(seeded);
      expect(opened.duplicate).toBe(false);
      const row = await claimRow(opened.claimId);
      expect(row).toMatchObject({
        orderId: seeded.orderId,
        orderItemId: null,
        kind: 'defect',
        openedVia: 'web',
        clientText: CLIENT_TEXT,
        decision: null,
        closedAt: null,
      });
      expect(row.photos).toHaveLength(2);
      expect(row.openedAt.getTime()).toBe(clock.now.getTime());
      expect(row.deadlineAt.getTime()).toBe(row.openedAt.getTime() + 10 * DAY);
      expect(opened.deadlineAt.getTime()).toBe(row.deadlineAt.getTime());

      const events = await eventsOf(db, seeded.orderId);
      expect(events.map((e) => [e.type, e.fromStatus, e.toStatus])).toEqual([
        ['claim_opened', 'handed', 'handed'],
      ]);
      expect(events[0]?.payload).toMatchObject({
        claimId: opened.claimId,
        claimKind: 'defect',
        via: 'web',
        photoCount: 2,
      });
      const journal = JSON.stringify(events);
      expect(journal).not.toContain('Течёт');
      expect(journal).not.toContain('345-67-89');
      assertNoPhone(events, seeded.phone);
      const notify = (await outboxOf(db, seeded.orderId)).filter((r) => r.queue === 'notify');
      expect(notify.map((r) => r.data)).toEqual([
        expect.objectContaining({ audience: 'client', template: 'claim_received' }),
        expect.objectContaining({ audience: 'owner', template: 'staff_claim_deadline' }),
        expect.objectContaining({ audience: 'sellers', template: 'staff_claim_opened' }),
      ]);
      expect(JSON.stringify(notify)).not.toContain('Течёт');
    });

    it('the same request key twice gives one claim; a second open claim on the target is refused', async () => {
      const seeded = await handedOrder();
      const requestKey = uuidv7();
      const first = await open(seeded, { requestKey });
      const again = await openClaim(deps, {
        orderId: seeded.orderId,
        kind: 'defect',
        text: 'повтор',
        via: 'web',
        requestKey,
        actor: clientOf(seeded),
      });
      expect(again).toMatchObject({ ok: true, claimId: first.claimId, duplicate: true });
      const other = await openClaim(deps, {
        orderId: seeded.orderId,
        kind: 'defect',
        via: 'web',
        requestKey: uuidv7(),
        actor: clientOf(seeded),
      });
      expect(other).toMatchObject({ ok: false, reason: 'already_open' });
      // Another item is a separate target.
      const item = await openClaim(deps, {
        orderId: seeded.orderId,
        itemId: seeded.itemIds[0],
        kind: 'not_fit',
        via: 'web',
        requestKey: uuidv7(),
        actor: clientOf(seeded),
      });
      expect(item.ok).toBe(true);
      const rows = await db.select().from(claims).where(eq(claims.orderId, seeded.orderId));
      expect(rows).toHaveLength(2);
      expect(
        (await eventsOf(db, seeded.orderId)).filter((e) => e.type === 'claim_opened'),
      ).toHaveLength(2);
    });

    it('refusal: the 7th day after the handover is the last one, the 8th is refused', async () => {
      const seeded = await handedOrder();
      // Handed on Mon 5 Oct 12:00 local: the 7th day is Mon 12 Oct.
      clock.now = new Date(T0.getTime() + 7 * DAY);
      const seventh = await openClaim(deps, {
        orderId: seeded.orderId,
        itemId: seeded.itemIds[0],
        kind: 'refusal',
        via: 'web',
        requestKey: uuidv7(),
        actor: clientOf(seeded),
      });
      expect(seventh.ok).toBe(true);
      clock.now = new Date(T0.getTime() + 8 * DAY);
      const eighth = await openClaim(deps, {
        orderId: seeded.orderId,
        itemId: seeded.itemIds[1],
        kind: 'refusal',
        via: 'web',
        requestKey: uuidv7(),
        actor: clientOf(seeded),
      });
      expect(eighth).toMatchObject({
        ok: false,
        reason: 'kind_unavailable',
        kinds: ['defect'],
      });
      if (!eighth.ok) expect(eighth.message).toContain('7 дней');
    });

    it('validates the input and the client', async () => {
      const seeded = await handedOrder();
      const base = {
        orderId: seeded.orderId,
        kind: 'defect' as const,
        via: 'web' as const,
        actor: clientOf(seeded),
      };
      const bad = async (overrides: Partial<Parameters<typeof openClaim>[1]>) =>
        openClaim(deps, { ...base, requestKey: uuidv7(), ...overrides });
      expect(await bad({ text: 'x'.repeat(1001) })).toMatchObject({
        ok: false,
        reason: 'bad_input',
      });
      expect(
        await bad({ photoKeys: [1, 2, 3, 4].map(() => fileKey('claim', seeded.orderId)) }),
      ).toMatchObject({ ok: false, reason: 'bad_input' });
      // Keys of another order or scope, or a path walking out of the folder.
      expect(await bad({ photoKeys: [fileKey('claim', uuidv7())] })).toMatchObject({
        reason: 'bad_input',
      });
      expect(await bad({ photoKeys: [fileKey('order', seeded.orderId)] })).toMatchObject({
        reason: 'bad_input',
      });
      expect(await bad({ photoKeys: [`claim/${seeded.orderId}/../x.jpg`] })).toMatchObject({
        reason: 'bad_input',
      });
      expect(await bad({ requestKey: 'nope' })).toMatchObject({ reason: 'bad_input' });
      expect(await bad({ itemId: uuidv7() })).toMatchObject({ reason: 'bad_input' });
      expect(await bad({ actor: { type: 'client', id: uuidv7() } })).toMatchObject({
        reason: 'not_found',
      });
      expect(await db.select().from(claims).where(eq(claims.orderId, seeded.orderId))).toEqual([]);
    });
  });

  describe('decision refund (Verification 1C V7, V8)', () => {
    it('without «Принял возврат» a seller gets guard_failed and no refund rows', async () => {
      const seeded = await handedOrder();
      const opened = await open(seeded);
      const actions = await loadStaffActions1C(deps, seeded.orderId, 'seller');
      expect(actions?.find((a) => a.code === 'cref')).toMatchObject({
        claimId: opened.claimId,
        enabled: false,
        disabledReason: 'Сначала «Принял возврат»',
      });
      const result = await decideClaim(deps, {
        claimId: opened.claimId,
        decision: 'refund',
        text: 'Возвращаем деньги',
        staff: seller,
      });
      expect(result).toMatchObject({
        ok: false,
        message: 'Сначала «Принял возврат» с фото детали',
      });
      expect(await refundsOf(seeded.orderId)).toEqual([]);
      expect((await orderRow(db, seeded.orderId)).status).toBe('handed');
      expect(await claimRow(opened.claimId)).toMatchObject({ decision: null, closedAt: null });
      // The owner without a reason is refused the same way; the button says a reason is needed.
      const ownerActions = await loadStaffActions1C(deps, seeded.orderId, 'owner');
      expect(ownerActions?.find((a) => a.code === 'cref')).toMatchObject({
        enabled: true,
        needsReason: true,
        label: 'Вернуть деньги (нужна причина)',
      });
      expect(
        await decideClaim(deps, {
          claimId: opened.claimId,
          decision: 'refund',
          text: 'Возвращаем',
          staff: owner,
          overrideReason: '  ',
        }),
      ).toMatchObject({
        ok: false,
        message: 'Деталь не принята: укажите причину возврата без приёмки',
      });
      // A seller may not pass a reason at all.
      expect(
        await decideClaim(deps, {
          claimId: opened.claimId,
          decision: 'refund',
          text: 'Возвращаем',
          staff: seller,
          overrideReason: 'потому что',
        }),
      ).toMatchObject({ ok: false, message: 'Только владелец' });
      expect(await refundsOf(seeded.orderId)).toEqual([]);
      const types = (await eventsOf(db, seeded.orderId)).map((e) => e.type);
      expect(types).toEqual(['claim_opened']);
    });

    it('«Принял возврат» with a photo -> refund -> refund_pending -> refunded, refund_full, deadline from the claim', async () => {
      const seeded = await handedOrder();
      const opened = await open(seeded);
      const openedAt = (await claimRow(opened.claimId)).openedAt;

      // «Принял возврат» needs the photo key.
      expect(
        await performStaffAction(deps, { staff: seller, action: 'cret', targetId: opened.claimId }),
      ).toMatchObject({ ok: false, message: 'Пришлите фото возвращённой детали' });
      clock.advance(HOUR);
      const photoKey = fileKey('order', seeded.orderId);
      const accepted = await performStaffAction(deps, {
        staff: seller,
        action: 'cret',
        targetId: opened.claimId,
        input: { photoKey },
      });
      expect(accepted).toMatchObject({ ok: true, orderId: seeded.orderId });
      const [photo] = await db
        .select()
        .from(orderPhotos)
        .where(eq(orderPhotos.orderId, seeded.orderId));
      expect(photo).toMatchObject({ kind: 'return', claimId: opened.claimId, s3Key: photoKey });
      expect((await claimRow(opened.claimId)).returnAcceptedAt?.getTime()).toBe(
        clock.now.getTime(),
      );
      // From the bot no sellers card is re-posted (the bot redraws its own card).
      const afterReturn = (await outboxOf(db, seeded.orderId)).filter(
        (r) => r.queue === 'notify' && (r.data as { note?: string }).note !== undefined,
      );
      expect(afterReturn).toEqual([]);

      const actions = await loadStaffActions1C(deps, seeded.orderId, 'seller');
      expect(actions?.find((a) => a.code === 'cref')).toMatchObject({ enabled: true });
      expect(actions?.map((a) => a.code)).not.toContain('cret');

      // The decision two days later: the deadline still runs from the client's request.
      clock.advance(2 * DAY);
      expect(
        await performStaffAction(deps, { staff: seller, action: 'cref', targetId: opened.claimId }),
      ).toMatchObject({ ok: false, message: 'Напишите ответ клиенту — до 2000 символов' });
      const decided = await performStaffAction(deps, {
        staff: seller,
        action: 'cref',
        targetId: opened.claimId,
        input: { text: 'Брак подтверждён, возвращаем деньги' },
      });
      expect(decided).toMatchObject({ ok: true, message: 'Возврат денег по претензии создан' });
      expect((await orderRow(db, seeded.orderId)).status).toBe('refund_pending');

      const [refund] = await refundsOf(seeded.orderId);
      expect(refund).toMatchObject({
        scope: 'order',
        reason: 'defect',
        amountKop: seeded.totalKop,
        status: 'pending',
      });
      expect(refund!.requestedAt.getTime()).toBe(openedAt.getTime());
      expect(refund!.deadlineAt.getTime()).toBe(openedAt.getTime() + 10 * DAY);
      const claim = await claimRow(opened.claimId);
      expect(claim).toMatchObject({
        decision: 'refund',
        decisionText: 'Брак подтверждён, возвращаем деньги',
        decidedVia: 'bot',
        refundId: refund!.id,
        overrideReason: null,
      });
      expect(claim.closedAt?.getTime()).toBe(clock.now.getTime());
      const [refundReceipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.refundId, refund!.id));
      expect(refundReceipt?.kind).toBe('refund_full');
      const lines = (refundReceipt?.request as { lines: { paymentMode: string }[] }).lines;
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.paymentMode === 'full_payment')).toBe(true);

      const events = await eventsOf(db, seeded.orderId);
      const approved = events.find((e) => e.type === 'claim_refund_approved');
      expect(approved).toMatchObject({ fromStatus: 'handed', toStatus: 'refund_pending' });
      expect(approved?.payload).toMatchObject({
        claimId: opened.claimId,
        refundId: refund!.id,
        receipt: 'refund_full',
      });
      // The refund journal is written at the decision, not back-dated to the request.
      const created = events.find((e) => e.type === 'refund_created');
      expect(created?.createdAt.getTime()).toBe(clock.now.getTime());
      // One decision instant: the refund journal and the transition share created_at.
      expect(events.map((e) => e.type).sort()).toEqual(
        [
          'claim_opened',
          'claim_return_accepted',
          'refund_created',
          'claim_refund_approved',
          'supplier_return_created',
          'claim_decided',
        ].sort(),
      );
      expect(JSON.stringify(events)).not.toContain('Брак подтверждён');
      const notifies = (await outboxOf(db, seeded.orderId)).filter((r) => r.queue === 'notify');
      const templates = notifies.map((r) => (r.data as { template: string }).template);
      expect(templates.slice(-3)).toEqual([
        'refund_started',
        'claim_decided',
        'staff_claim_opened',
      ]);
      // The accepted part lies at the point: a claim to Rossko per item (a defect) and the
      // sellers' task; the reminder before supplier_return_deadline_at picks the rows up.
      const returnsToRossko = await db
        .select()
        .from(supplierReturns)
        .where(sql`${supplierReturns.note} = ${`claim:${opened.claimId}`}`);
      expect(returnsToRossko.map((r) => [r.kind, r.status]).sort()).toEqual([
        ['claim', 'requested'],
        ['claim', 'requested'],
      ]);
      expect((notifies.at(-1)?.data as { note?: string }).note).toMatch(
        /^Возврат по претензии: деталь у вас — вернуть Rossko/,
      );

      // The provider confirms: refunded, the refund receipt succeeded.
      const out = await succeedRefund(seeded, refund!.id, seeded.totalKop);
      expect(out.transition).toMatchObject({ ok: true, to: 'refunded' });
      expect((await itemRows(db, seeded.orderId)).map((i) => i.state)).toEqual([
        'refunded',
        'refunded',
      ]);
      const [receipt] = await db.select().from(receipts).where(eq(receipts.refundId, refund!.id));
      expect(receipt?.status).toBe('succeeded');
      // A second decision is refused.
      expect(
        await decideClaim(deps, {
          claimId: opened.claimId,
          decision: 'reject',
          text: 'нет',
          staff: owner,
        }),
      ).toMatchObject({ ok: false, message: 'Решение по претензии уже принято' });
    });

    it('the owner refunds without the return with a reason, kept in order_events', async () => {
      const seeded = await handedOrder();
      const opened = await open(seeded);
      const result = await performStaffAction(deps, {
        staff: owner,
        action: 'cref',
        targetId: opened.claimId,
        input: {
          text: 'Возвращаем деньги',
          reason: 'деталь утилизирована клиентом по согласованию',
        },
      });
      expect(result).toMatchObject({ ok: true });
      expect((await orderRow(db, seeded.orderId)).status).toBe('refund_pending');
      const approved = (await eventsOf(db, seeded.orderId)).find(
        (e) => e.type === 'claim_refund_approved',
      );
      expect(approved).toMatchObject({ actorId: 'admin' });
      expect(approved?.payload).toMatchObject({
        overrideReason: 'деталь утилизирована клиентом по согласованию',
      });
      expect(await claimRow(opened.claimId)).toMatchObject({
        overrideReason: 'деталь утилизирована клиентом по согласованию',
        decidedBy: null,
        decidedVia: 'admin',
      });
      // No part at the point: nothing to return to Rossko.
      const rows = await db
        .select()
        .from(supplierReturns)
        .where(sql`${supplierReturns.note} = ${`claim:${opened.claimId}`}`);
      expect(rows).toEqual([]);
    });

    it('a claim on one item: a partial refund, the order stays handed', async () => {
      const seeded = await handedOrder();
      const itemId = seeded.itemIds[0]!;
      const opened = await open(seeded, { itemId, kind: 'not_fit' });
      await acceptClaimReturn(deps, {
        claimId: opened.claimId,
        photoKey: fileKey('order', seeded.orderId),
        staff: seller,
      });
      const decided = await decideClaim(deps, {
        claimId: opened.claimId,
        decision: 'refund',
        text: 'Возвращаем за фильтр',
        staff: seller,
      });
      expect(decided.ok).toBe(true);
      expect((await orderRow(db, seeded.orderId)).status).toBe('handed');
      const [refund] = await refundsOf(seeded.orderId);
      expect(refund).toMatchObject({ scope: 'item', reason: 'not_fit', amountKop: 128_000 });
      // The client hears of a claim refund of that item, not of a cancelled position.
      const clientTemplates = (await outboxOf(db, seeded.orderId))
        .filter(
          (r) => r.queue === 'notify' && (r.data as { audience: string }).audience === 'client',
        )
        .map((r) => (r.data as { template: string }).template);
      expect(clientTemplates).toContain('claim_refund_started');
      expect(clientTemplates).not.toContain('item_cancelled');
      const [toRossko] = await db
        .select()
        .from(supplierReturns)
        .where(eq(supplierReturns.orderItemId, itemId));
      expect(toRossko).toMatchObject({
        kind: 'return',
        status: 'requested',
        note: `claim:${opened.claimId}`,
      });
      expect((await itemRows(db, seeded.orderId)).map((i) => i.state)).toEqual([
        'refund_pending',
        'handed',
      ]);
      const out = await succeedRefund(seeded, refund!.id, 128_000);
      expect(out.transition).toMatchObject({ ok: true, from: 'handed', to: 'handed' });
      expect((await itemRows(db, seeded.orderId)).map((i) => i.state)).toEqual([
        'refunded',
        'handed',
      ]);
      // The claim is closed: the completion timer may run.
      clock.advance(7 * DAY);
      const completed = await applyTransition(deps, {
        orderId: seeded.orderId,
        event: 'completion_timeout',
        actor: { type: 'system', id: null },
      });
      expect(completed).toMatchObject({ ok: true, to: 'completed' });
    });
  });

  describe('replace, reject, completion', () => {
    it('replace keeps the order handed (completion_timeout guard_failed) until «Замена выдана»', async () => {
      const seeded = await handedOrder();
      const itemId = seeded.itemIds[1]!;
      const opened = await open(seeded, { itemId });
      const blocked = await applyTransition(deps, {
        orderId: seeded.orderId,
        event: 'completion_timeout',
        actor: { type: 'system', id: null },
      });
      expect(blocked).toMatchObject({
        ok: false,
        reason: 'guard_failed',
        failed: ['no_open_claims'],
      });

      const replaced = await performStaffAction(deps, {
        staff: seller,
        action: 'crepl',
        targetId: opened.claimId,
        input: { text: 'Заменим фильтр на новый' },
      });
      expect(replaced).toMatchObject({ ok: true });
      const claim = await claimRow(opened.claimId);
      expect(claim).toMatchObject({ decision: 'replace', closedAt: null });
      const [ret] = await db
        .select()
        .from(supplierReturns)
        .where(eq(supplierReturns.orderItemId, itemId));
      expect(ret).toMatchObject({ kind: 'claim', status: 'requested', amountExpectedKop: 50_000 });
      // No receipt and no refund for an exchange.
      expect(await refundsOf(seeded.orderId)).toEqual([]);
      const task = (await outboxOf(db, seeded.orderId)).find(
        (r) => (r.data as { note?: string }).note !== undefined,
      );
      expect(task?.data).toMatchObject({ audience: 'sellers', template: 'staff_claim_opened' });
      expect(
        (
          await applyTransition(deps, {
            orderId: seeded.orderId,
            event: 'completion_timeout',
            actor: { type: 'system', id: null },
          })
        ).ok,
      ).toBe(false);
      expect((task?.data as { note: string }).note).not.toContain('Заказано вручную');
      // «Замена выдана» waits for the replacement purchase («Замена заказана», admin).
      const actions = await loadStaffActions1C(deps, seeded.orderId, 'seller');
      expect(actions?.filter((a) => a.claimId)).toEqual([
        expect.objectContaining({
          code: 'cclose',
          enabled: false,
          disabledReason: REPLACEMENT_NOT_ORDERED,
        }),
      ]);
      expect(
        await performStaffAction(deps, {
          staff: seller,
          action: 'cclose',
          targetId: opened.claimId,
          input: { note: 'выдали новый' },
        }),
      ).toMatchObject({ ok: false });
      expect(
        await orderClaimReplacement(deps, {
          claimId: opened.claimId,
          rosskoOrderIds: [' '],
          staff: owner,
        }),
      ).toMatchObject({ ok: false, message: 'Укажите номера заказов Rossko' });
      clock.advance(HOUR);
      expect(
        await orderClaimReplacement(deps, {
          claimId: opened.claimId,
          rosskoOrderIds: ['R-777', 'R-777'],
          staff: owner,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await orderClaimReplacement(deps, {
          claimId: opened.claimId,
          rosskoOrderIds: ['R-778'],
          staff: owner,
        }),
      ).toMatchObject({ ok: false, message: 'Замена уже заказана' });
      // A new order item replaces the claimed one; the purchase is a supplier order.
      const afterOrder = await itemRows(db, seeded.orderId);
      const old = afterOrder.find((i) => i.id === itemId)!;
      expect(old.state).toBe('replaced');
      const fresh = afterOrder.find((i) => i.id === old.replacedByItemId)!;
      expect(fresh).toMatchObject({
        state: 'ordered',
        brand: old.brand,
        article: old.article,
        priceClientKop: old.priceClientKop,
        priceSupplierAtOrderKop: old.priceSupplierAtOrderKop,
        refundedAmountKop: 0,
      });
      const ordered = await claimRow(opened.claimId);
      expect(ordered.replacementOrderedAt?.getTime()).toBe(clock.now.getTime());
      const [purchase] = await db
        .select()
        .from(supplierOrders)
        .where(eq(supplierOrders.id, ordered.replacementSupplierOrderId!));
      expect(purchase).toMatchObject({
        orderId: seeded.orderId,
        status: 'created',
        rosskoOrderIds: ['R-777'],
      });
      const links = await db
        .select()
        .from(supplierOrderItems)
        .where(eq(supplierOrderItems.supplierOrderId, purchase!.id));
      expect(links.map((l) => l.orderItemId)).toEqual([fresh.id]);
      // The order total is untouched: the old line is replaced, the new one has its price.
      expect((await orderRow(db, seeded.orderId)).totalKop).toBe(seeded.totalKop);
      expect((await orderRow(db, seeded.orderId)).status).toBe('handed');
      const enabled = await loadStaffActions1C(deps, seeded.orderId, 'seller');
      expect(enabled?.filter((a) => a.claimId).map((a) => [a.code, a.enabled])).toEqual([
        ['cclose', true],
      ]);

      expect(
        await performStaffAction(deps, {
          staff: seller,
          action: 'cclose',
          targetId: opened.claimId,
          input: { note: 'выдали новый' },
        }),
      ).toMatchObject({ ok: true });
      expect(await claimRow(opened.claimId)).toMatchObject({ replacementNote: 'выдали новый' });
      const handedNow = (await itemRows(db, seeded.orderId)).find((i) => i.id === fresh.id);
      expect(handedNow?.state).toBe('handed');
      expect(
        await applyTransition(deps, {
          orderId: seeded.orderId,
          event: 'completion_timeout',
          actor: { type: 'system', id: null },
        }),
      ).toMatchObject({ ok: true, to: 'completed' });
      const journal = await eventsOf(db, seeded.orderId);
      expect(journal.map((e) => e.type)).toEqual([
        'claim_opened',
        'supplier_return_created',
        'claim_decided',
        'claim_replacement_ordered',
        'claim_closed',
        'completion_timeout',
      ]);
      expect(journal.find((e) => e.type === 'claim_replacement_ordered')?.payload).toMatchObject({
        claimId: opened.claimId,
        supplierOrderId: purchase!.id,
        rosskoOrderIds: ['R-777'],
        itemIds: [itemId],
        newItemIds: [fresh.id],
      });
      // A claim on the replacement is possible once it is handed.
      const second = await open(seeded, { itemId: fresh.id });
      expect(second.ok).toBe(true);
    });

    it('reject needs the text and closes the claim; the client gets only «ответ готов»', async () => {
      const seeded = await handedOrder();
      const opened = await open(seeded);
      expect(
        await decideClaim(deps, {
          claimId: opened.claimId,
          decision: 'reject',
          text: ' ',
          staff: seller,
        }),
      ).toMatchObject({ ok: false });
      const text =
        'Следы установки с нарушением, гарантия не действует. Тел. сервиса 8 912 000-00-00';
      expect(
        await decideClaim(deps, {
          claimId: opened.claimId,
          decision: 'reject',
          text,
          staff: seller,
        }),
      ).toMatchObject({ ok: true });
      const claim = await claimRow(opened.claimId);
      expect(claim).toMatchObject({ decision: 'reject', decisionText: text });
      expect(claim.closedAt).not.toBeNull();
      expect(await closeClaim(deps, { claimId: opened.claimId, staff: seller })).toMatchObject({
        ok: false,
        message: 'Претензия уже закрыта',
      });
      const decided = (await outboxOf(db, seeded.orderId)).filter(
        (r) => (r.data as { template?: string }).template === 'claim_decided',
      );
      expect(decided).toHaveLength(1);
      expect(JSON.stringify(decided)).not.toContain('гарантия');
      expect(JSON.stringify(await eventsOf(db, seeded.orderId))).not.toContain('гарантия');

      // Read models: texts only on request.
      const plain = await loadClaimsView(db, seeded.orderId);
      expect(plain).toEqual([
        expect.objectContaining({
          id: opened.claimId,
          decision: 'reject',
          open: false,
          clientText: null,
          decisionText: null,
          photoCount: 2,
        }),
      ]);
      const full = await loadClaimsView(db, seeded.orderId, { texts: true });
      expect(full[0]).toMatchObject({ clientText: CLIENT_TEXT, decisionText: text });
    });
  });

  describe('delay', () => {
    it('before the handover: a delay claim -> refund = client_refused, refund_prepayment, reason delay', async () => {
      const seeded = await seedOrder(db, { status: 'ordered_at_supplier' });
      // Promised for Sat 3 Oct, today is Mon 5 Oct: the client may claim the delay.
      await db
        .update(orders)
        .set({ promisedDate: '2026-10-03' })
        .where(eq(orders.id, seeded.orderId));
      const refusal = await openClaim(deps, {
        orderId: seeded.orderId,
        kind: 'refusal',
        via: 'web',
        requestKey: uuidv7(),
        actor: clientOf(seeded),
      });
      expect(refusal).toMatchObject({ ok: false, reason: 'kind_unavailable', kinds: ['delay'] });
      const opened = await open(seeded, { kind: 'delay', photoKeys: [] });
      expect((await orderRow(db, seeded.orderId)).status).toBe('ordered_at_supplier');
      const openedAt = (await claimRow(opened.claimId)).openedAt;

      // No «Принял возврат» for a delay; «Вернуть деньги» is open to a seller.
      const actions = await loadStaffActions1C(deps, seeded.orderId, 'seller');
      const claimCodes = actions?.filter((a) => a.claimId).map((a) => [a.code, a.enabled]);
      expect(claimCodes).toEqual([
        ['cref', true],
        ['crej', true],
      ]);
      clock.advance(DAY);
      const decided = await decideClaim(deps, {
        claimId: opened.claimId,
        decision: 'refund',
        text: 'Срок сорван, возвращаем деньги',
        staff: seller,
      });
      expect(decided).toMatchObject({ ok: true });
      expect((await orderRow(db, seeded.orderId)).status).toBe('refund_pending');
      const [refund] = await refundsOf(seeded.orderId);
      expect(refund).toMatchObject({ reason: 'delay', scope: 'order' });
      expect(refund!.deadlineAt.getTime()).toBe(openedAt.getTime() + 10 * DAY);
      const [receipt] = await db.select().from(receipts).where(eq(receipts.refundId, refund!.id));
      expect(receipt?.kind).toBe('refund_prepayment');
      const refused = (await eventsOf(db, seeded.orderId)).find((e) => e.type === 'client_refused');
      expect(refused?.payload).toMatchObject({ claimId: opened.claimId, decision: 'refund' });
      expect(await claimRow(opened.claimId)).toMatchObject({ refundId: refund!.id });
    });

    it('a delay claim needs held money; compensation is the owner’s and only for a delay', async () => {
      const unpaid = await seedOrder(db, {
        status: 'ordered_at_supplier',
        scheme: 'pay_on_handover',
        payment: null,
      });
      await db
        .update(orders)
        .set({ promisedDate: '2026-10-01' })
        .where(eq(orders.id, unpaid.orderId));
      expect(
        await openClaim(deps, {
          orderId: unpaid.orderId,
          kind: 'delay',
          via: 'admin',
          requestKey: uuidv7(),
          actor: { type: 'staff', id: 'admin', staffRole: 'owner' },
        }),
      ).toMatchObject({ ok: false, reason: 'kind_unavailable', kinds: [] });

      const late = await handedOrder();
      // Handed on 5 Oct, promised for 3 Oct: a delay after the handover.
      await setHanded(db, late.orderId, T0, '2026-10-03');
      const opened = await open(late, { kind: 'delay', photoKeys: [] });
      expect(
        await recordClaimCompensation(deps, {
          claimId: opened.claimId,
          amountKop: 960,
          staff: seller,
        }),
      ).toMatchObject({ ok: false, message: 'Только владелец' });
      expect(
        await recordClaimCompensation(deps, {
          claimId: opened.claimId,
          amountKop: late.totalKop + 1,
          staff: owner,
        }),
      ).toMatchObject({ ok: false });
      expect(
        await recordClaimCompensation(deps, {
          claimId: opened.claimId,
          amountKop: 960,
          staff: owner,
        }),
      ).toMatchObject({ ok: true });
      expect(await claimRow(opened.claimId)).toMatchObject({ compensationAmountKop: 960 });
      const journal = (await eventsOf(db, late.orderId)).find(
        (e) => e.type === 'claim_compensation',
      );
      expect(journal?.payload).toMatchObject({ claimId: opened.claimId, amountKop: 960 });

      const defect = await open(late, { itemId: late.itemIds[0] });
      expect(
        await recordClaimCompensation(deps, {
          claimId: defect.claimId,
          amountKop: 100,
          staff: owner,
        }),
      ).toMatchObject({ ok: false, message: 'Компенсация — только по претензии о просрочке' });
    });
  });

  describe('delay: audit of phase 1C', () => {
    it('after the handover a delay is compensated, never refunded: no «Вернуть деньги», decideClaim refuses', async () => {
      const late = await handedOrder();
      await setHanded(db, late.orderId, T0, '2026-10-03');
      const opened = await open(late, { kind: 'delay', photoKeys: [] });
      for (const role of ['seller', 'owner'] as const) {
        const codes = (await loadStaffActions1C(deps, late.orderId, role))
          ?.filter((a) => a.claimId === opened.claimId)
          .map((a) => a.code);
        expect(codes).toEqual(['crej']);
      }
      for (const staff of [seller, owner]) {
        expect(
          await decideClaim(deps, {
            claimId: opened.claimId,
            decision: 'refund',
            text: 'Возвращаем деньги',
            staff,
            ...(staff.role === 'owner' ? { overrideReason: 'просрочка' } : {}),
          }),
        ).toMatchObject({
          ok: false,
          message: 'По просрочке после получения — компенсация (неустойка), не возврат денег',
        });
      }
      // «Принял возврат» does not open the refund either.
      await acceptClaimReturn(deps, {
        claimId: opened.claimId,
        photoKey: fileKey('order', late.orderId),
        staff: seller,
      });
      expect(
        await decideClaim(deps, {
          claimId: opened.claimId,
          decision: 'refund',
          text: 'Возвращаем деньги',
          staff: seller,
        }),
      ).toMatchObject({ ok: false });
      expect(await refundsOf(late.orderId)).toEqual([]);
      expect((await orderRow(db, late.orderId)).status).toBe('handed');
      // The owner answers with the compensation (art. 23.1) and closes the claim.
      expect(
        await decideClaim(deps, {
          claimId: opened.claimId,
          decision: 'reject',
          text: 'Неустойка 0,5% в день, перечислим на карту',
          staff: owner,
          compensationKop: 1_500,
        }),
      ).toMatchObject({ ok: true });
      expect(await claimRow(opened.claimId)).toMatchObject({
        decision: 'reject',
        compensationAmountKop: 1_500,
      });
    });

    it('before the handover a delay is claimed for the whole order only', async () => {
      const seeded = await seedOrder(db, { status: 'ordered_at_supplier' });
      await db
        .update(orders)
        .set({ promisedDate: '2026-10-03' })
        .where(eq(orders.id, seeded.orderId));
      const result = await openClaim(deps, {
        orderId: seeded.orderId,
        itemId: seeded.itemIds[0]!,
        kind: 'delay',
        via: 'web',
        requestKey: uuidv7(),
        actor: clientOf(seeded),
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'bad_input',
        message: DELAY_WHOLE_ORDER_ONLY,
      });
      const [none] = await db.select().from(claims).where(eq(claims.orderId, seeded.orderId));
      expect(none).toBeUndefined();

      // A legacy item delay claim (opened before the fix) gets no refund of the whole order.
      const legacy = await open(seeded, { kind: 'delay', photoKeys: [] });
      await db
        .update(claims)
        .set({ orderItemId: seeded.itemIds[0]! })
        .where(eq(claims.id, legacy.claimId));
      const codes = (await loadStaffActions1C(deps, seeded.orderId, 'owner'))
        ?.filter((a) => a.claimId === legacy.claimId)
        .map((a) => a.code);
      expect(codes).toEqual(['crej']);
      expect(
        await decideClaim(deps, {
          claimId: legacy.claimId,
          decision: 'refund',
          text: 'Возвращаем',
          staff: owner,
        }),
      ).toMatchObject({ ok: false, message: 'Возврат по претензии в этом статусе недоступен' });
      expect((await orderRow(db, seeded.orderId)).status).toBe('ordered_at_supplier');
    });
  });

  describe('open claims superseded by a refund or a cancellation', () => {
    it('the client refuses on the order page with a delay claim open: the claim closes', async () => {
      const seeded = await seedOrder(db, { status: 'ordered_at_supplier' });
      await db
        .update(orders)
        .set({ promisedDate: '2026-10-03' })
        .where(eq(orders.id, seeded.orderId));
      const opened = await open(seeded, { kind: 'delay', photoKeys: [] });
      clock.advance(HOUR);
      const refused = await applyTransition(deps, {
        orderId: seeded.orderId,
        event: 'client_refused',
        actor: clientOf(seeded),
      });
      expect(refused).toMatchObject({ ok: true, to: 'refund_pending' });
      const claim = await claimRow(opened.claimId);
      expect(claim.closedAt?.getTime()).toBe(clock.now.getTime());
      expect(claim.decision).toBeNull();
      const closed = (await eventsOf(db, seeded.orderId)).find((e) => e.type === 'claim_closed');
      expect(closed?.payload).toMatchObject({
        claimId: opened.claimId,
        reason: 'superseded',
        status: 'refund_pending',
      });
      // No «Отказать» left, no answer deadline reminder target.
      expect(
        (await loadStaffActions1C(deps, seeded.orderId, 'owner'))?.filter((a) => a.claimId),
      ).toEqual([]);
      expect(
        await decideClaim(deps, {
          claimId: opened.claimId,
          decision: 'reject',
          text: 'нет',
          staff: owner,
        }),
      ).toMatchObject({ ok: false, message: 'Решение по претензии уже принято' });
    });

    it('a whole-order claim refund closes the open item claims, not the decided one', async () => {
      const seeded = await handedOrder();
      const itemClaim = await open(seeded, { itemId: seeded.itemIds[0]! });
      const whole = await open(seeded, { kind: 'not_fit' });
      await acceptClaimReturn(deps, {
        claimId: whole.claimId,
        photoKey: fileKey('order', seeded.orderId),
        staff: seller,
      });
      clock.advance(HOUR);
      expect(
        await decideClaim(deps, {
          claimId: whole.claimId,
          decision: 'refund',
          text: 'Возвращаем за весь заказ',
          staff: seller,
        }),
      ).toMatchObject({ ok: true });
      expect((await orderRow(db, seeded.orderId)).status).toBe('refund_pending');
      expect(await claimRow(whole.claimId)).toMatchObject({ decision: 'refund' });
      const superseded = await claimRow(itemClaim.claimId);
      expect(superseded.decision).toBeNull();
      expect(superseded.closedAt?.getTime()).toBe(clock.now.getTime());
      const closed = (await eventsOf(db, seeded.orderId)).filter((e) => e.type === 'claim_closed');
      expect(closed.map((e) => (e.payload as { claimId: string }).claimId)).toEqual([
        itemClaim.claimId,
      ]);
      // The client hears «ответ готов» once — for the decided claim only.
      const decided = (await outboxOf(db, seeded.orderId)).filter(
        (r) => (r.data as { template?: string }).template === 'claim_decided',
      );
      expect(decided).toHaveLength(1);
    });
  });

  describe('photos', () => {
    it('packaging photo: one row per key, journal, only keys of the order', async () => {
      const seeded = await seedOrder(db, { status: 'ordered_at_supplier' });
      const key = fileKey('order', seeded.orderId);
      const first = await performStaffAction(deps, {
        staff: seller,
        action: 'pphoto',
        targetId: seeded.orderId,
        input: { photoKey: key },
      });
      expect(first).toMatchObject({ ok: true, message: 'Фото сохранено' });
      const again = await addOrderPhoto(deps, {
        orderId: seeded.orderId,
        kind: 'packaging',
        fileKey: key,
        staff: seller,
      });
      expect(again).toMatchObject({ ok: true, message: 'Фото уже сохранено' });
      expect(
        await addOrderPhoto(deps, {
          orderId: seeded.orderId,
          kind: 'packaging',
          fileKey: fileKey('order', uuidv7()),
          staff: seller,
        }),
      ).toMatchObject({ ok: false });
      expect(
        await addOrderPhoto(deps, {
          orderId: seeded.orderId,
          kind: 'packaging',
          fileKey: `order/${seeded.orderId}/../../etc/passwd`,
          staff: seller,
        }),
      ).toMatchObject({ ok: false });
      const photos = await loadOrderPhotos(db, seeded.orderId, ['packaging']);
      expect(photos).toEqual([expect.objectContaining({ kind: 'packaging', key })]);
      expect(await loadOrderPhotos(db, seeded.orderId, ['return'])).toEqual([]);
      const events = (await eventsOf(db, seeded.orderId)).filter((e) => e.type === 'photo_added');
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ kind: 'packaging', via: 'bot' });
    });

    it('«arrived» to a messenger client waits 2 minutes in the outbox for the packaging photo', async () => {
      const arrive = async (bound: boolean) => {
        const seeded = await seedOrder(db, {
          status: 'ordered_at_supplier',
          items: [
            {
              brand: 'MANN',
              article: 'W 914/2',
              priceClientKop: 128_000,
              priceSupplierKop: 100_000,
            },
          ],
        });
        if (bound) {
          const tg = String(Date.now());
          await bindMessenger(db, {
            userId: seeded.userId,
            channel: 'telegram',
            externalUserId: tg,
            chatId: tg,
          });
        }
        const arrived = await performStaffAction(deps, {
          staff: seller,
          action: 'iarr',
          targetId: seeded.itemIds[0]!,
        });
        expect(arrived.ok).toBe(true);
        expect((await orderRow(db, seeded.orderId)).status).toBe('ready');
        const [row] = await db
          .select()
          .from(outbox)
          .where(
            and(eq(outbox.queue, 'notify'), sql`${outbox.data}->>'orderId' = ${seeded.orderId}`),
          );
        expect(row?.data).toMatchObject({ audience: 'client', template: 'arrived' });
        return { seeded, availableAt: row!.availableAt };
      };
      const telegram = await arrive(true);
      expect(telegram.availableAt.getTime()).toBe(clock.now.getTime() + 2 * 60_000);
      // An SMS client cannot get the photo: the message is due at once.
      const sms = await arrive(false);
      expect(sms.availableAt.getTime()).not.toBe(clock.now.getTime() + 2 * 60_000);
      // pphoto is offered at the point.
      const actions = await loadStaffActions1C(deps, telegram.seeded.orderId, 'seller');
      expect(actions?.map((a) => a.code)).toContain('pphoto');
    });
  });
});
