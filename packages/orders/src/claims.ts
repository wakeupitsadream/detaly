/**
 * Client claims (PLAN section 3, row «Претензия»; docs/phase-1c-implementation.md decisions
 * С7–С11): opening through the claim_opened transition (its effect open_claim writes the row),
 * «Принял возврат» with a photo, the decision with the answer text (refund / replace / reject),
 * «Замена выдана» and the owner's compensation for a delay.
 *
 * Everything runs under the order row lock in one transaction; notifications are outbox rows of
 * the same transaction, nudged after the commit. The client's text, the answer and the owner's
 * reason stay in the claims row: journal payloads carry ids, kinds and codes only (the override
 * reason is the one exception PLAN asks for: «причина в order_events»).
 */
import {
  and,
  asc,
  claims,
  eq,
  inArray,
  orderItems,
  orderPhotos,
  supplierOrderItems,
  supplierOrders,
  supplierReturns,
  type Executor,
} from '@detaly/db';
import {
  CLAIM_DECISION_TEXT_MAX,
  CLAIM_KINDS,
  CLAIM_PHOTOS_MAX,
  CLAIM_TEXT_MAX,
  claimKindsAvailable,
  FILE_KEY_PATTERN,
  formatDayMonth,
  localDate,
  REFUSABLE_STATUSES,
  type ClaimDecision,
  type ClaimKind,
  type ClaimOpenedVia,
  type OrderEvent,
  type OrderStatus,
} from '@detaly/domain';
import { v7 as uuidv7 } from 'uuid';
import { isLiveState, moneyHeldOf } from './context';
import { applyTransitionInTx, clock, nudge } from './engine';
import { enqueueNotify, recordJournalEvent } from './journal';
import { isUuid, loadOrderSnapshot } from './snapshot';
import type {
  ActorRef,
  ApplyResult,
  ClaimRow,
  ClaimView,
  EngineDeps,
  OpenClaimResult,
  OrderSnapshot,
  ServiceResult,
  StaffRef,
  TransitionFacts,
  Tx,
} from './types';

const FILE_KEY_RE = new RegExp(FILE_KEY_PATTERN);
const AFTER_HANDOVER: readonly OrderStatus[] = ['handed', 'completed'];
const REFUSABLE: readonly OrderStatus[] = REFUSABLE_STATUSES;
/** Free staff notes (override reason, replacement note): characters. */
const NOTE_MAX = 500;

/** Sellers card line of a replacement decision (decision С9). */
export const REPLACEMENT_TASK_NOTE =
  'Решение по претензии: замена — закажите замену в ЛК Rossko, запишите номер заказа («Замена заказана» в админке), затем «Замена выдана»';

/** «Замена выдана» before «Замена заказана»: the replacement purchase is not recorded yet. */
export const REPLACEMENT_NOT_ORDERED =
  'Сначала «Замена заказана» с номером заказа Rossko (админка)';

/** A delay before the handover is a refusal of the whole order (decision С10). */
export const DELAY_WHOLE_ORDER_ONLY =
  'Просрочку до получения заявляют по всему заказу: деньги возвращаются за весь заказ';

/**
 * Sellers card line of a claim refund with the part accepted back: the part lies at the point
 * and must go back to Rossko before the supplier window closes (PLAN section 3, risk 8), or to
 * stock («Rossko не принял»).
 */
export function supplierReturnTaskNote(deadline: Date | null): string {
  const until = deadline === null ? '' : ` до ${formatDayMonth(localDate(deadline))}`;
  return `Возврат по претензии: деталь у вас — вернуть Rossko${until} (возврат поставщику в админке); не примут — «Rossko не принял», деталь на склад`;
}

/** A FileStore key of this order: `<scope>/<order id>/<uuid>.jpg` with an allowed scope. */
export function isOrderFileKey(
  key: unknown,
  orderId: string,
  scopes: readonly ('order' | 'claim')[],
): key is string {
  if (typeof key !== 'string' || !FILE_KEY_RE.test(key)) return false;
  const [scope, owner] = key.split('/');
  return (scopes as readonly string[]).includes(scope ?? '') && owner === orderId;
}

/** The staff member as the engine actor (the admin acts as the owner with id 'admin'). */
export function staffActor(staff: StaffRef): ActorRef {
  return {
    type: 'staff',
    id: staff.id ?? (staff.via === 'admin' ? 'admin' : null),
    staffRole: staff.role,
  };
}

/** staff.id when it is a staff row (claims.decided_by, order_photos.by_staff_id reference staff). */
function staffRowId(staff: StaffRef): string | null {
  return isUuid(staff.id) ? staff.id : null;
}

/** A refusal that must not commit what the transaction wrote so far. */
class Refused extends Error {
  constructor(readonly result: ServiceResult) {
    super(result.message);
  }
}

/**
 * Runs `run` with the claim's order row locked (`for update`) and the claim row locked; nudges
 * after a commit. A result with ok:false rolls the transaction back.
 */
async function withLockedClaim(
  deps: EngineDeps,
  claimId: string,
  run: (locked: {
    tx: Tx;
    snapshot: OrderSnapshot;
    claim: ClaimRow;
    at: Date;
  }) => Promise<ServiceResult>,
): Promise<ServiceResult> {
  const missing: ServiceResult = { ok: false, message: 'Претензия не найдена', orderId: claimId };
  if (!isUuid(claimId)) return missing;
  try {
    const result = await deps.db.transaction(async (tx) => {
      const [head] = await tx
        .select({ orderId: claims.orderId })
        .from(claims)
        .where(eq(claims.id, claimId));
      if (!head) return missing;
      const snapshot = await loadOrderSnapshot(tx, head.orderId, { lock: true });
      if (snapshot === null) return missing;
      const [claim] = await tx.select().from(claims).where(eq(claims.id, claimId)).for('update');
      if (!claim) return missing;
      const out = await run({ tx, snapshot, claim, at: clock(deps) });
      if (!out.ok) throw new Refused(out);
      return out;
    });
    if (result.ok) nudge(deps);
    return result;
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------------

const KIND_UNAVAILABLE = 'Этот вид претензии сейчас недоступен';

function unavailableMessage(kind: ClaimKind, status: OrderStatus): string {
  if ((kind === 'refusal' || kind === 'not_fit') && AFTER_HANDOVER.includes(status)) {
    return 'Срок отказа — 7 дней после получения — прошёл. Если деталь неисправна, выберите «Брак»';
  }
  if (kind === 'delay') return 'Претензия о просрочке: срок получения ещё не прошёл';
  if (!AFTER_HANDOVER.includes(status)) return 'До получения детали можно заявить только просрочку';
  return KIND_UNAVAILABLE;
}

/**
 * Opens a claim (decision С7): kinds by claimKindsAvailable, one open claim per item / whole
 * order, the request key returns the same claim on a repeated form. The claims row is written by
 * the effect open_claim of claim_opened (deadline_at = opened_at + 10 days); the client gets
 * claim_received, the owner staff_claim_deadline, the sellers the order card.
 *
 * `actor` client: the web checked the order token and the 4 phone digits; staff: the admin or
 * the bot on the client's behalf.
 */
export async function openClaim(
  deps: EngineDeps,
  input: {
    orderId: string;
    itemId?: string | null;
    kind: ClaimKind;
    text?: string | null;
    /** FileStore keys claim/<order id>/<uuid>.jpg, already stored. */
    photoKeys?: readonly string[];
    via: ClaimOpenedVia;
    requestKey: string;
    actor: ActorRef;
  },
): Promise<OpenClaimResult> {
  const bad = (message: string): OpenClaimResult => ({ ok: false, reason: 'bad_input', message });
  if (!isUuid(input.orderId)) {
    return { ok: false, reason: 'not_found', message: 'Заказ не найден' };
  }
  if (!isUuid(input.requestKey)) return bad('Форма устарела — обновите страницу');
  if (!(CLAIM_KINDS as readonly string[]).includes(input.kind))
    return bad('Выберите вид претензии');
  const text = input.text?.trim() ?? '';
  if (text.length > CLAIM_TEXT_MAX)
    return bad(`Опишите проблему короче — до ${CLAIM_TEXT_MAX} символов`);
  const photos = [...(input.photoKeys ?? [])];
  if (photos.length > CLAIM_PHOTOS_MAX) return bad(`Не больше ${CLAIM_PHOTOS_MAX} фото`);
  if (!photos.every((key) => isOrderFileKey(key, input.orderId, ['claim']))) {
    return bad('Фото не сохранились — приложите их ещё раз');
  }
  if (new Set(photos).size !== photos.length) return bad('Одно и то же фото приложено дважды');
  const itemId = input.itemId ?? null;
  if (itemId !== null && !isUuid(itemId)) return bad('Позиция не найдена');
  if (input.actor.type !== 'client' && input.actor.type !== 'staff') {
    return { ok: false, reason: 'not_allowed', message: 'Действие недоступно' };
  }

  const result = await deps.db.transaction(async (tx): Promise<OpenClaimResult> => {
    const snapshot = await loadOrderSnapshot(tx, input.orderId, { lock: true });
    if (snapshot === null) return { ok: false, reason: 'not_found', message: 'Заказ не найден' };
    const { order } = snapshot;
    if (input.actor.type === 'client' && input.actor.id !== order.userId) {
      return { ok: false, reason: 'not_found', message: 'Заказ не найден' };
    }
    // The request key first: a repeated form returns the claim it created, whatever happened since.
    const [repeated] = await tx
      .select({ id: claims.id, orderId: claims.orderId, deadlineAt: claims.deadlineAt })
      .from(claims)
      .where(eq(claims.requestKey, input.requestKey));
    if (repeated) {
      if (repeated.orderId !== order.id) return bad('Форма устарела — обновите страницу');
      return {
        ok: true,
        claimId: repeated.id,
        orderId: order.id,
        deadlineAt: repeated.deadlineAt,
        duplicate: true,
      };
    }

    const now = clock(deps);
    const kinds = claimKindsAvailable({
      status: order.status,
      scheme: order.paymentScheme,
      moneyHeld: moneyHeldOf(snapshot),
      handedAt: order.handedAt,
      receivedAt: order.receivedAt,
      promisedDate: order.promisedDate,
      now,
    });
    if (!kinds.includes(input.kind)) {
      return {
        ok: false,
        reason: 'kind_unavailable',
        message: unavailableMessage(input.kind, order.status),
        kinds,
      };
    }
    // A delay before the handover is the refusal of the whole order (client_refused, decision
    // С10): a claim on one item would refund and cancel the items that came on time as well.
    if (itemId !== null && input.kind === 'delay' && REFUSABLE.includes(order.status)) {
      return bad(DELAY_WHOLE_ORDER_ONLY);
    }
    if (itemId !== null) {
      const item = snapshot.items.find((i) => i.id === itemId);
      const fits = AFTER_HANDOVER.includes(order.status)
        ? item?.state === 'handed'
        : item !== undefined && isLiveState(item.state);
      if (!fits) return bad('Позиция не найдена');
    }
    const open = snapshot.claims.some(
      (claim) => claim.closedAt === null && claim.orderItemId === itemId,
    );
    if (open) {
      return {
        ok: false,
        reason: 'already_open',
        message:
          itemId === null
            ? 'По заказу уже есть открытая претензия — ответим на неё'
            : 'По этой позиции уже есть открытая претензия — ответим на неё',
      };
    }

    const claimId = uuidv7();
    const applied = await applyTransitionInTx(
      tx,
      deps,
      {
        orderId: order.id,
        event: 'claim_opened',
        actor: input.actor,
        itemId,
        facts: {
          claimKind: input.kind,
          claim: {
            id: claimId,
            kind: input.kind,
            orderItemId: itemId,
            clientText: text === '' ? null : text,
            photos,
            openedVia: input.via,
            requestKey: input.requestKey,
          },
        },
        payload: { via: input.via },
      },
      { snapshot },
    );
    if (!applied.ok) {
      return {
        ok: false,
        reason: 'guard_failed',
        message:
          applied.failed.includes('money_held') || applied.failed.includes('claim_is_delay')
            ? 'Претензия о просрочке — только по оплаченному заказу'
            : KIND_UNAVAILABLE,
      };
    }
    const [row] = await tx
      .select({ deadlineAt: claims.deadlineAt })
      .from(claims)
      .where(eq(claims.id, claimId));
    return {
      ok: true,
      claimId,
      orderId: order.id,
      deadlineAt: (row as { deadlineAt: Date }).deadlineAt,
      duplicate: false,
    };
  });
  if (result.ok && !result.duplicate) nudge(deps);
  return result;
}

// ---------------------------------------------------------------------------------------------
// «Принял возврат»
// ---------------------------------------------------------------------------------------------

/**
 * «Принял возврат» (decision С8): only with a photo of the returned part — order_photos kind
 * return with the claim, claims.return_accepted_at, journal claim_return_accepted. From the admin
 * the sellers chat gets the updated order card (the bot redraws its own card after a press).
 */
export async function acceptClaimReturn(
  deps: EngineDeps,
  input: { claimId: string; photoKey: string; staff: StaffRef },
): Promise<ServiceResult> {
  return withLockedClaim(deps, input.claimId, async ({ tx, snapshot, claim, at }) => {
    const { order } = snapshot;
    const refuse = (message: string): ServiceResult => ({ ok: false, message, orderId: order.id });
    if (!isOrderFileKey(input.photoKey, order.id, ['order', 'claim'])) {
      return refuse('Пришлите фото возвращённой детали');
    }
    if (claim.closedAt !== null) return refuse('Претензия уже закрыта');
    if (claim.decision !== null) return refuse('Решение по претензии уже принято');
    if (!AFTER_HANDOVER.includes(order.status)) return refuse('Деталь ещё не выдана клиенту');

    const [existing] = await tx
      .select({ id: orderPhotos.id })
      .from(orderPhotos)
      .where(and(eq(orderPhotos.orderId, order.id), eq(orderPhotos.s3Key, input.photoKey)));
    let photoId = existing?.id ?? null;
    if (photoId === null) {
      const [photo] = await tx
        .insert(orderPhotos)
        .values({
          orderId: order.id,
          kind: 'return',
          s3Key: input.photoKey,
          byStaffId: staffRowId(input.staff),
          claimId: claim.id,
          orderItemId: claim.orderItemId,
          createdAt: at,
        })
        .returning({ id: orderPhotos.id });
      photoId = (photo as { id: string }).id;
    }
    if (claim.returnAcceptedAt !== null) {
      return {
        ok: true,
        message: 'Фото добавлено, возврат уже принят',
        orderId: order.id,
        photoId,
      };
    }
    await tx
      .update(claims)
      .set({ returnAcceptedAt: at, updatedAt: at })
      .where(eq(claims.id, claim.id));
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId: order.id,
      type: 'claim_return_accepted',
      actor: staffActor(input.staff),
      payload: { claimId: claim.id, photoId, via: input.staff.via },
      at,
    });
    if (input.staff.via === 'admin') {
      await enqueueNotify(tx, {
        orderId: order.id,
        orderEventId,
        audience: 'sellers',
        template: 'staff_claim_opened',
        note: 'Возврат детали по претензии принят',
      });
    }
    return {
      ok: true,
      message: 'Возврат принят — теперь можно решить претензию',
      orderId: order.id,
      photoId,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------------------------

/** The refund event of a claim and its facts (decisions С9, С10); null: no refund in this status. */
function refundEventFor(
  snapshot: OrderSnapshot,
  claim: ClaimRow,
  overrideReason: string | null,
): { event: OrderEvent; itemId: string | null; facts: TransitionFacts } | null {
  const status = snapshot.order.status;
  const base: TransitionFacts = {
    claimKind: claim.kind,
    returnAccepted: claim.returnAcceptedAt !== null,
    claimId: claim.id,
    claimOpenedAt: claim.openedAt.toISOString(),
    ...(overrideReason !== null ? { ownerOverrideReason: overrideReason } : {}),
  };
  if (AFTER_HANDOVER.includes(status)) {
    // A delay after the handover: the part stays with the client, art. 23.1 gives a penalty
    // (the owner's compensation), never the price back (guard claim_refundable_kind).
    if (claim.kind === 'delay') return null;
    const itemId = claim.orderItemId;
    return {
      event: 'claim_refund_approved',
      itemId,
      facts: { ...base, scope: itemId === null ? 'order' : 'item' },
    };
  }
  // A delay before the handover is the refusal rule (refund_pending, refund_prepayment) of the
  // whole order; openClaim takes no item for it (a legacy item claim gets no refund here).
  if (claim.kind === 'delay' && claim.orderItemId === null && REFUSABLE.includes(status)) {
    return { event: 'client_refused', itemId: null, facts: { ...base, scope: 'order' } };
  }
  return null;
}

/** The handed items a claim is about: its item, or every handed item of a whole-order claim. */
function handedTargets(snapshot: OrderSnapshot, claim: ClaimRow) {
  return snapshot.items.filter(
    (item) =>
      item.state === 'handed' && (claim.orderItemId === null || item.id === claim.orderItemId),
  );
}

function refundRefusal(result: Extract<ApplyResult, { ok: false }>, staff: StaffRef): string {
  if (result.failed.includes('claim_refundable_kind')) {
    return 'По просрочке после получения — компенсация (неустойка), не возврат денег';
  }
  if (result.failed.includes('claim_refund_allowed')) {
    return staff.role === 'owner'
      ? 'Деталь не принята: укажите причину возврата без приёмки'
      : 'Сначала «Принял возврат» с фото детали';
  }
  if (result.failed.includes('no_refundable_payment') || result.failed.includes('money_held')) {
    return 'Нет оплаты, которую можно вернуть';
  }
  if (result.failed.includes('refund_plan')) return 'Сумма возврата превышает платёж';
  if (result.failed.includes('payments_disabled')) return 'Оплата не настроена (ЮKassa)';
  if (result.failed.includes('no_phone')) return 'У клиента нет телефона для чека';
  if (result.reason === 'no_rule') return 'Возврат по претензии в этом статусе недоступен';
  return 'Возврат сейчас недоступен';
}

/**
 * The decision on a claim, always with the answer to the client (1..2000 characters, shown on
 * /o/<token>; the messenger only says «ответ готов»):
 * - refund: claim_refund_approved (after the handover; never for a delay, art. 23.1 gives a
 *   penalty there) or client_refused (a whole-order delay before it) with the claim facts;
 *   refunds.requested_at = claims.opened_at, reason = the claim kind, claims.refund_id; the claim
 *   closes (the refund lives on with its own deadline). Without «Принял возврат» only the owner
 *   with a reason (in order_events); with it the part goes back to Rossko (supplier_returns
 *   kind return, or claim for a defect) and the sellers get the task;
 * - replace: supplier_returns kind claim per item + a task to the sellers; the claim stays open
 *   through «Замена заказана» (orderClaimReplacement) until «Замена выдана» (closeClaim); no
 *   receipt (VERIFY: an exchange for the same goods);
 * - reject: a reasoned answer, the claim closes.
 */
export async function decideClaim(
  deps: EngineDeps,
  input: {
    claimId: string;
    decision: ClaimDecision;
    text: string;
    staff: StaffRef;
    /** Owner only: refund without «Принял возврат». */
    overrideReason?: string | null;
    /** Owner only, delay only (art. 23.1): recorded with the decision. */
    compensationKop?: number | null;
  },
): Promise<ServiceResult> {
  const text = input.text?.trim() ?? '';
  const reason = input.overrideReason?.trim() ?? '';
  return withLockedClaim(deps, input.claimId, async ({ tx, snapshot, claim, at }) => {
    const { order } = snapshot;
    const refuse = (message: string): ServiceResult => ({ ok: false, message, orderId: order.id });
    if (text === '' || text.length > CLAIM_DECISION_TEXT_MAX) {
      return refuse(`Напишите ответ клиенту — до ${CLAIM_DECISION_TEXT_MAX} символов`);
    }
    if (reason !== '' && input.staff.role !== 'owner') return refuse('Только владелец');
    if (reason.length > NOTE_MAX) return refuse(`Причина — до ${NOTE_MAX} символов`);
    if (claim.closedAt !== null || claim.decision !== null) {
      return refuse('Решение по претензии уже принято');
    }
    const actor = staffActor(input.staff);
    let overrideUsed: string | null = null;
    let message: string;
    /** A note for the sellers' card: the replacement or the return to Rossko to arrange. */
    let supplierTask: string | null = null;

    switch (input.decision) {
      case 'refund': {
        // The reason counts only where it is needed: no accepted return and not a delay.
        const needsOverride = claim.kind !== 'delay' && claim.returnAcceptedAt === null;
        overrideUsed = needsOverride && reason !== '' ? reason : null;
        const plan = refundEventFor(snapshot, claim, overrideUsed);
        if (plan === null) {
          return refuse(
            claim.kind === 'delay' && AFTER_HANDOVER.includes(order.status)
              ? 'По просрочке после получения — компенсация (неустойка), не возврат денег'
              : 'Возврат по претензии в этом статусе недоступен',
          );
        }
        // The part accepted back lies at the point: a return to Rossko (a defect is a claim to
        // the supplier), with the sellers' task below and the reminder before the deadline.
        const returned =
          plan.event === 'claim_refund_approved' && claim.returnAcceptedAt !== null
            ? handedTargets(snapshot, claim)
            : [];
        const applied = await applyTransitionInTx(
          tx,
          deps,
          {
            orderId: order.id,
            event: plan.event,
            actor,
            itemId: plan.itemId,
            facts: plan.facts,
            payload: {
              via: input.staff.via,
              claimId: claim.id,
              decision: 'refund',
              ...(overrideUsed !== null ? { overrideReason: overrideUsed } : {}),
            },
          },
          { snapshot },
        );
        if (!applied.ok) return refuse(refundRefusal(applied, input.staff));
        if (returned.length > 0) {
          const kind = claim.kind === 'defect' ? ('claim' as const) : ('return' as const);
          const rows = await tx
            .insert(supplierReturns)
            .values(
              returned.map((item) => ({
                orderItemId: item.id,
                kind,
                status: 'requested' as const,
                amountExpectedKop: item.priceSupplierAtOrderKop * item.qty,
                note: `claim:${claim.id}`,
                createdAt: at,
                updatedAt: at,
              })),
            )
            .returning({ id: supplierReturns.id });
          await recordJournalEvent(tx, {
            orderId: order.id,
            type: 'supplier_return_created',
            actor,
            payload: {
              supplierReturnIds: rows.map((r) => r.id),
              kind,
              itemIds: returned.map((i) => i.id),
              claimId: claim.id,
            },
            at,
          });
          supplierTask = supplierReturnTaskNote(order.supplierReturnDeadlineAt);
        }
        message = 'Возврат денег по претензии создан';
        break;
      }
      case 'replace': {
        if (claim.kind === 'delay' || !AFTER_HANDOVER.includes(order.status)) {
          return refuse('Замена — только по выданной детали');
        }
        const targets = handedTargets(snapshot, claim);
        if (targets.length === 0) return refuse('Нет выданной позиции для замены');
        const rows = await tx
          .insert(supplierReturns)
          .values(
            targets.map((item) => ({
              orderItemId: item.id,
              kind: 'claim' as const,
              status: 'requested' as const,
              amountExpectedKop: item.priceSupplierAtOrderKop * item.qty,
              note: `claim:${claim.id}`,
              createdAt: at,
              updatedAt: at,
            })),
          )
          .returning({ id: supplierReturns.id });
        await recordJournalEvent(tx, {
          orderId: order.id,
          type: 'supplier_return_created',
          actor,
          payload: {
            supplierReturnIds: rows.map((r) => r.id),
            kind: 'claim',
            itemIds: targets.map((i) => i.id),
            claimId: claim.id,
          },
          at,
        });
        supplierTask = REPLACEMENT_TASK_NOTE;
        message = 'Решение: замена. Закажите замену у Rossko, затем «Замена заказана» в админке';
        break;
      }
      case 'reject':
        message = 'Отказ по претензии записан';
        break;
      default:
        return refuse('Выберите решение');
    }

    await tx
      .update(claims)
      .set({
        decision: input.decision,
        decisionText: text,
        decidedAt: at,
        decidedVia: input.staff.via,
        decidedBy: staffRowId(input.staff),
        overrideReason: overrideUsed,
        ...(input.decision === 'replace' ? {} : { closedAt: at }),
        updatedAt: at,
      })
      .where(eq(claims.id, claim.id));
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId: order.id,
      type: 'claim_decided',
      actor,
      payload: { claimId: claim.id, decision: input.decision, via: input.staff.via },
      at,
    });
    // The client is told only that the answer is ready (the text may hold PD: /o/<token> only).
    await enqueueNotify(tx, {
      orderId: order.id,
      orderEventId,
      audience: 'client',
      template: 'claim_decided',
    });
    if (supplierTask !== null) {
      await enqueueNotify(tx, {
        orderId: order.id,
        orderEventId,
        audience: 'sellers',
        template: 'staff_claim_opened',
        note: supplierTask,
      });
    }
    if (input.compensationKop !== undefined && input.compensationKop !== null) {
      const refused = await writeCompensation(tx, {
        snapshot,
        claim,
        amountKop: input.compensationKop,
        staff: input.staff,
        at,
      });
      if (refused !== null) return refuse(refused);
    }
    return { ok: true, message, orderId: order.id };
  });
}

/** Rossko order numbers of a manual purchase: trimmed, non-empty, at most 64 characters. */
const ROSSKO_ID_MAX = 64;

/**
 * «Замена заказана» (PLAN section 3: replace → a new order of the item): for a claim decided
 * as replace, each handed item it covers gets a replacement order_items row (state ordered, the
 * same prices: an exchange for the same goods, no receipt) and the old row becomes `replaced`
 * with replaced_by_item_id; one `created` supplier order with the Rossko numbers covers the
 * replacements (supplier_orders / supplier_order_items: the purchase is in the books and in the
 * journal for the act). claims.replacement_ordered_at opens «Замена выдана».
 */
export async function orderClaimReplacement(
  deps: EngineDeps,
  input: { claimId: string; rosskoOrderIds: readonly string[]; staff: StaffRef },
): Promise<ServiceResult> {
  const ids = [...new Set(input.rosskoOrderIds.map((id) => id.trim()).filter((id) => id !== ''))];
  return withLockedClaim(deps, input.claimId, async ({ tx, snapshot, claim, at }) => {
    const { order } = snapshot;
    const refuse = (message: string): ServiceResult => ({ ok: false, message, orderId: order.id });
    if (ids.length === 0 || ids.some((id) => id.length > ROSSKO_ID_MAX)) {
      return refuse('Укажите номера заказов Rossko');
    }
    if (claim.closedAt !== null) return refuse('Претензия уже закрыта');
    if (claim.decision !== 'replace') return refuse('Замена — только по решению «Замена»');
    if (claim.replacementOrderedAt !== null) return refuse('Замена уже заказана');
    if (!AFTER_HANDOVER.includes(order.status)) return refuse('Замена — только по выданной детали');
    const targets = handedTargets(snapshot, claim);
    if (targets.length === 0) return refuse('Нет выданной позиции для замены');

    const attemptNo = Math.max(0, ...snapshot.supplierOrders.map((s) => s.attemptNo)) + 1;
    const [created] = await tx
      .insert(supplierOrders)
      .values({ orderId: order.id, attemptNo, status: 'created', rosskoOrderIds: ids })
      .returning({ id: supplierOrders.id });
    const supplierOrderId = (created as { id: string }).id;
    const newItemIds: string[] = [];
    // VERIFY: Rossko terms of a replacement under a claim (free against the returned part, or a
    // new purchase at today's price): the replacement row keeps the supplier price of the order.
    for (const old of targets) {
      const id = uuidv7();
      await tx.insert(orderItems).values({
        id,
        orderId: order.id,
        offerKey: old.offerKey,
        searchArticleNorm: old.searchArticleNorm,
        brand: old.brand,
        article: old.article,
        name: old.name,
        qty: old.qty,
        stockId: old.stockId,
        isLocal: old.isLocal,
        priceSupplierAtOrderKop: old.priceSupplierAtOrderKop,
        priceClientKop: old.priceClientKop,
        markupBp: old.markupBp,
        etaDate: old.etaDate,
        offerSnapshot: old.offerSnapshot,
        state: 'ordered',
        createdAt: at,
        updatedAt: at,
      });
      await tx
        .update(orderItems)
        .set({ state: 'replaced', replacedByItemId: id, updatedAt: at })
        .where(and(eq(orderItems.id, old.id), eq(orderItems.orderId, order.id)));
      newItemIds.push(id);
    }
    await tx
      .insert(supplierOrderItems)
      .values(newItemIds.map((orderItemId) => ({ supplierOrderId, orderItemId })));
    await tx
      .update(claims)
      .set({ replacementOrderedAt: at, replacementSupplierOrderId: supplierOrderId, updatedAt: at })
      .where(eq(claims.id, claim.id));
    await recordJournalEvent(tx, {
      orderId: order.id,
      type: 'claim_replacement_ordered',
      actor: staffActor(input.staff),
      payload: {
        claimId: claim.id,
        supplierOrderId,
        rosskoOrderIds: ids,
        itemIds: targets.map((i) => i.id),
        newItemIds,
        via: input.staff.via,
      },
      at,
    });
    return {
      ok: true,
      message: 'Замена заказана. Когда клиент получит деталь — «Замена выдана»',
      orderId: order.id,
    };
  });
}

/**
 * «Замена выдана»: closes a claim decided as replace once the replacement was ordered
 * («Замена заказана»); its replacement items become handed (journal claim_closed).
 */
export async function closeClaim(
  deps: EngineDeps,
  input: { claimId: string; staff: StaffRef; note?: string | null },
): Promise<ServiceResult> {
  const note = input.note?.trim().slice(0, NOTE_MAX) || null;
  return withLockedClaim(deps, input.claimId, async ({ tx, snapshot, claim, at }) => {
    const { order } = snapshot;
    if (claim.closedAt !== null) {
      return { ok: false, message: 'Претензия уже закрыта', orderId: order.id };
    }
    if (claim.decision !== 'replace') {
      return { ok: false, message: 'Закрыть можно только претензию с заменой', orderId: order.id };
    }
    if (claim.replacementOrderedAt === null || claim.replacementSupplierOrderId === null) {
      return { ok: false, message: REPLACEMENT_NOT_ORDERED, orderId: order.id };
    }
    const links = await tx
      .select({ id: supplierOrderItems.orderItemId })
      .from(supplierOrderItems)
      .where(eq(supplierOrderItems.supplierOrderId, claim.replacementSupplierOrderId));
    const handed = snapshot.items.filter(
      (item) => item.state === 'ordered' && links.some((link) => link.id === item.id),
    );
    if (handed.length > 0) {
      await tx
        .update(orderItems)
        .set({ state: 'handed', arrivedAt: at, updatedAt: at })
        .where(
          and(
            eq(orderItems.orderId, order.id),
            inArray(
              orderItems.id,
              handed.map((item) => item.id),
            ),
          ),
        );
    }
    await tx
      .update(claims)
      .set({ closedAt: at, replacementNote: note, updatedAt: at })
      .where(eq(claims.id, claim.id));
    await recordJournalEvent(tx, {
      orderId: order.id,
      type: 'claim_closed',
      actor: staffActor(input.staff),
      payload: {
        claimId: claim.id,
        decision: 'replace',
        via: input.staff.via,
        itemIds: handed.map((item) => item.id),
      },
      at,
    });
    return { ok: true, message: 'Замена выдана, претензия закрыта', orderId: order.id };
  });
}

async function writeCompensation(
  tx: Tx,
  input: {
    snapshot: OrderSnapshot;
    claim: ClaimRow;
    amountKop: number;
    staff: StaffRef;
    at: Date;
  },
): Promise<string | null> {
  const { snapshot, claim, amountKop, staff, at } = input;
  if (staff.role !== 'owner') return 'Только владелец';
  if (claim.kind !== 'delay') return 'Компенсация — только по претензии о просрочке';
  // Art. 23.1: the penalty never exceeds the amount paid in advance.
  if (!Number.isSafeInteger(amountKop) || amountKop <= 0 || amountKop > snapshot.order.totalKop) {
    return 'Сумма компенсации — больше нуля и не больше суммы заказа';
  }
  await tx
    .update(claims)
    .set({ compensationAmountKop: amountKop, updatedAt: at })
    .where(eq(claims.id, claim.id));
  await recordJournalEvent(tx, {
    orderId: snapshot.order.id,
    type: 'claim_compensation',
    actor: staffActor(staff),
    payload: { claimId: claim.id, amountKop, via: staff.via },
    at,
  });
  return null;
}

/**
 * Compensation under art. 23.1 (owner only, delay only): claims.compensation_amount_kop and the
 * journal. Paid outside the system by a payment order without a receipt (VERIFY: ФНС position,
 * PLAN section 3).
 */
export async function recordClaimCompensation(
  deps: EngineDeps,
  input: { claimId: string; amountKop: number; staff: StaffRef },
): Promise<ServiceResult> {
  if (input.staff.role !== 'owner') {
    return { ok: false, message: 'Только владелец', orderId: input.claimId };
  }
  return withLockedClaim(deps, input.claimId, async ({ tx, snapshot, claim, at }) => {
    const refused = await writeCompensation(tx, {
      snapshot,
      claim,
      amountKop: input.amountKop,
      staff: input.staff,
      at,
    });
    return refused === null
      ? { ok: true, message: 'Компенсация записана', orderId: snapshot.order.id }
      : { ok: false, message: refused, orderId: snapshot.order.id };
  });
}

// ---------------------------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------------------------

/**
 * Claims of an order, oldest first. Texts (the client's description, the answer, the owner's
 * reason, the replacement note) only with `texts: true`: the admin and /o/<token> show them,
 * bot cards and messengers never do.
 */
export async function loadClaimsView(
  db: Executor,
  orderId: string,
  options: { texts?: boolean } = {},
): Promise<ClaimView[]> {
  if (!isUuid(orderId)) return [];
  const rows = await db
    .select()
    .from(claims)
    .where(eq(claims.orderId, orderId))
    .orderBy(asc(claims.openedAt), asc(claims.id));
  if (rows.length === 0) return [];
  const itemIds = rows.map((r) => r.orderItemId).filter((id): id is string => id !== null);
  const [items, photos] = await Promise.all([
    itemIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: orderItems.id, brand: orderItems.brand, article: orderItems.article })
          .from(orderItems)
          .where(inArray(orderItems.id, itemIds)),
    db
      .select({
        id: orderPhotos.id,
        key: orderPhotos.s3Key,
        claimId: orderPhotos.claimId,
        createdAt: orderPhotos.createdAt,
      })
      .from(orderPhotos)
      .where(and(eq(orderPhotos.orderId, orderId), eq(orderPhotos.kind, 'return')))
      .orderBy(asc(orderPhotos.createdAt), asc(orderPhotos.id)),
  ]);
  const texts = options.texts === true;
  return rows.map((row) => {
    const item = items.find((i) => i.id === row.orderItemId) ?? null;
    const keys = Array.isArray(row.photos) ? row.photos : [];
    return {
      id: row.id,
      orderId: row.orderId,
      orderItemId: row.orderItemId,
      item,
      kind: row.kind,
      openedAt: row.openedAt,
      deadlineAt: row.deadlineAt,
      decision: row.decision,
      decidedAt: row.decidedAt,
      returnAcceptedAt: row.returnAcceptedAt,
      compensationAmountKop: row.compensationAmountKop,
      refundId: row.refundId,
      closedAt: row.closedAt,
      replacementOrderedAt: row.replacementOrderedAt,
      photoCount: keys.length,
      photos: keys,
      returnPhotos: photos
        .filter((p) => p.claimId === row.id)
        .map((p) => ({ id: p.id, key: p.key, createdAt: p.createdAt })),
      openedVia: (row.openedVia as ClaimView['openedVia']) ?? null,
      decidedVia: (row.decidedVia as ClaimView['decidedVia']) ?? null,
      clientText: texts ? row.clientText : null,
      decisionText: texts ? row.decisionText : null,
      overrideReason: texts ? row.overrideReason : null,
      replacementNote: texts ? row.replacementNote : null,
      open: row.closedAt === null,
    };
  });
}
