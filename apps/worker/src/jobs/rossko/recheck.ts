/**
 * rossko/recheck {orderId, eventId, staffId} (decision Б12, docs/phase-1b-implementation.md
 * section 11). «Проверить и заказать» wrote the journal event `recheck_requested` and this job:
 *
 * 1. the order must still be `confirmed` (otherwise the job is stale and exits);
 * 2. GetSearch bypassing the cache, priority `critical`, once per unique search_article_norm of
 *    the pending items;
 * 3. recheckOrder (pure, @detaly/domain): order drift, availability, alternatives;
 * 4. under the order row lock: journal `recheck_result` (no PD: ids, prices, offers) and
 *    applyTransition('supplier_order_requested', system, {priceDriftBp, allAvailable, reason}):
 *    `ordering` with a `sending` supplier order and the rossko/checkout job (effect
 *    supplier_checkout), or `needs_attention` with the alternatives in the journal.
 *
 * Supplier or quota errors are retried by the queue (3 attempts); the last failed attempt writes
 * `recheck_result` with `ok: false` and posts a seller card «Rossko не ответил» instead of
 * failing, so the seller can press the button again.
 */
import { and, eq, excludedGroups, orderEvents, sql } from '@detaly/db';
import {
  DEFAULT_EXCLUDED_RULES,
  MoneyError,
  RecheckError,
  recheckOrder,
  type ExcludedRule,
  type Offer,
  type RecheckItemInput,
  type RecheckResult,
} from '@detaly/domain';
import {
  applyTransition,
  loadOrderSettings,
  loadOrderSnapshot,
  recordJournalEvent,
  type ApplyResult,
  type OrderItemRow,
} from '@detaly/orders';
import { searchFailure } from '@detaly/rossko';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';
import { refreshCard } from '../receipts/offset';
import {
  SYSTEM_ACTOR,
  errorText,
  isFinalAttempt,
  nudge,
  optionalUuidField,
  uuidField,
} from './shared';

/** Seller card note after the last failed attempt (no PD). */
export const RECHECK_UNAVAILABLE_NOTE =
  'Rossko не ответил на перепроверку. Нажмите «Проверить и заказать» ещё раз.';

export type RecheckJobResult =
  | { outcome: 'skipped'; reason: 'not_found' | 'status' | 'no_items' | 'done' }
  | {
      outcome: 'applied';
      to: string;
      priceDriftBp: number;
      allAvailable: boolean;
      recheckEventId: string;
    }
  | { outcome: 'not_applied'; reason: string; recheckEventId: string }
  | { outcome: 'supplier_unavailable'; recheckEventId: string | null };

/** GetSearch answered success=false with something other than "nothing found". */
export class SupplierSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierSearchError';
  }
}

/** Active excluded_groups rules; the domain defaults when the table is empty. */
async function loadExcludedRules(deps: WorkerDeps): Promise<ExcludedRule[]> {
  const rows = await deps.db
    .select({
      kind: excludedGroups.kind,
      pattern: excludedGroups.pattern,
      reason: excludedGroups.reason,
    })
    .from(excludedGroups)
    .where(eq(excludedGroups.active, true));
  return rows.length > 0 ? rows : [...DEFAULT_EXCLUDED_RULES];
}

/** Items the recheck covers: live items not ordered yet (in `confirmed` every item is pending). */
function recheckItems(items: readonly OrderItemRow[]): OrderItemRow[] {
  return items.filter((item) => item.state === 'pending');
}

function toRecheckInput(item: OrderItemRow): RecheckItemInput {
  return {
    orderItemId: item.id,
    offerKey: item.offerKey,
    searchArticleNorm: item.searchArticleNorm,
    qty: item.qty,
    priceSupplierKop: item.priceSupplierAtOrderKop,
    priceClientKop: item.priceClientKop,
    offer: item.offerSnapshot as Offer,
  };
}

/** Fresh offers per search article, bypassing the cache. Supplier errors are thrown. */
async function freshOffers(
  deps: WorkerDeps,
  articles: readonly string[],
): Promise<Map<string, Offer[]>> {
  const fresh = new Map<string, Offer[]>();
  for (const article of articles) {
    const result = await deps.rossko.search(article, { bypassCache: true, priority: 'critical' });
    if (result.offers.length === 0 && result.message !== null) {
      // An error answer looks like "nothing found" (no offers): never read it as "gone".
      const failure = searchFailure({ success: false, message: result.message });
      if (failure !== null) throw new SupplierSearchError(failure);
    }
    fresh.set(article, result.offers);
  }
  return fresh;
}

/** The journal payload of a recheck: ids, prices and supplier offers only (no PD). */
function resultPayload(
  requestEventId: string,
  staffId: string | null,
  toleranceBp: number,
  result: RecheckResult,
): Record<string, unknown> {
  return {
    ok: true,
    requestEventId,
    requestedBy: staffId,
    priceDriftBp: result.priceDriftBp,
    driftToleranceBp: toleranceBp,
    allAvailable: result.allAvailable,
    reason: result.reason,
    oldSupplierTotalKop: result.oldSupplierTotalKop,
    freshSupplierTotalKop: result.freshSupplierTotalKop,
    items: result.items,
  };
}

/** A recheck_result for this request already exists (the job ran again after it). */
async function alreadyRechecked(
  deps: WorkerDeps,
  orderId: string,
  requestEventId: string,
): Promise<boolean> {
  const rows = await deps.db
    .select({ id: orderEvents.id })
    .from(orderEvents)
    .where(
      and(
        eq(orderEvents.orderId, orderId),
        eq(orderEvents.type, 'recheck_result'),
        sql`${orderEvents.payload}->>'requestEventId' = ${requestEventId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function processRecheck(job: Job, deps: WorkerDeps): Promise<RecheckJobResult> {
  const orderId = uuidField(job, 'orderId');
  const requestEventId = uuidField(job, 'eventId');
  const staffId = optionalUuidField(job, 'staffId');
  const log = deps.logger.child({ job: 'rossko/recheck', orderId, jobId: job.id });

  const snapshot = await loadOrderSnapshot(deps.db, orderId, { lock: false });
  if (snapshot === null) return { outcome: 'skipped', reason: 'not_found' };
  if (snapshot.order.status !== 'confirmed') {
    log.info({ status: snapshot.order.status }, 'recheck skipped: order is not confirmed');
    return { outcome: 'skipped', reason: 'status' };
  }
  if (await alreadyRechecked(deps, orderId, requestEventId)) {
    return { outcome: 'skipped', reason: 'done' };
  }
  const items = recheckItems(snapshot.items);
  if (items.length === 0) return { outcome: 'skipped', reason: 'no_items' };

  const settings = await loadOrderSettings(deps.db, deps.env);
  const excludedRules = await loadExcludedRules(deps);
  const articles = [...new Set(items.map((item) => item.searchArticleNorm))];

  let fresh: Map<string, Offer[]>;
  try {
    fresh = await freshOffers(deps, articles);
  } catch (error) {
    if (!isFinalAttempt(job)) {
      log.warn({ err: errorText(error), attemptsMade: job.attemptsMade }, 'recheck: retry');
      throw error;
    }
    return supplierUnavailable(deps, job, { orderId, requestEventId, staffId, error });
  }

  let result: RecheckResult;
  try {
    result = recheckOrder({
      items: items.map(toRecheckInput),
      freshBySearch: fresh,
      pricing: settings.pricing,
      excludedRules,
      eta: settings.eta,
      now: deps.now(),
      marginFloorBp: settings.marginFloorBp,
      driftToleranceBp: settings.driftToleranceBp,
    });
  } catch (error) {
    // Bad order data: retrying cannot help.
    if (error instanceof RecheckError || error instanceof MoneyError) {
      throw new UnrecoverableError(`recheck: ${error.message}`);
    }
    throw error;
  }

  const at = deps.now();
  const outcome = await deps.db.transaction(async (tx) => {
    const locked = await loadOrderSnapshot(tx, orderId, { lock: true });
    if (locked === null || locked.order.status !== 'confirmed') return null;
    const { orderEventId: recheckEventId } = await recordJournalEvent(tx, {
      orderId,
      type: 'recheck_result',
      actor: SYSTEM_ACTOR,
      payload: resultPayload(requestEventId, staffId, settings.driftToleranceBp, result),
      at,
    });
    const applied: ApplyResult = await applyTransition(deps.engine, {
      orderId,
      event: 'supplier_order_requested',
      actor: SYSTEM_ACTOR,
      facts: {
        priceDriftBp: result.priceDriftBp,
        allAvailable: result.allAvailable,
        ...(result.reason === null ? {} : { reason: result.reason }),
      },
      payload: { recheckEventId, requestEventId, requestedBy: staffId },
      tx,
    });
    return { recheckEventId, applied };
  });

  if (outcome === null) return { outcome: 'skipped', reason: 'status' };
  const { recheckEventId, applied } = outcome;
  nudge(deps);
  if (!applied.ok) {
    log.warn({ reason: applied.reason, failed: applied.failed }, 'recheck: transition refused');
    return { outcome: 'not_applied', reason: applied.reason, recheckEventId };
  }
  // The sellers card still shows «Проверить и заказать» of `confirmed`: redraw it for
  // `ordering` (best effort; needs_attention also gets a new card from the notify queue).
  await refreshCard(deps, { orderId });
  log.info(
    { to: applied.to, priceDriftBp: result.priceDriftBp, allAvailable: result.allAvailable },
    'recheck applied',
  );
  return {
    outcome: 'applied',
    to: applied.to,
    priceDriftBp: result.priceDriftBp,
    allAvailable: result.allAvailable,
    recheckEventId,
  };
}

/**
 * The last attempt failed on the supplier side: journal `recheck_result` with `ok: false` and a
 * seller card; the order stays `confirmed`, so «Проверить и заказать» is offered again.
 */
async function supplierUnavailable(
  deps: WorkerDeps,
  job: Job,
  input: { orderId: string; requestEventId: string; staffId: string | null; error: unknown },
): Promise<RecheckJobResult> {
  const { orderId } = input;
  const at = deps.now();
  const recheckEventId = await deps.db.transaction(async (tx) => {
    const locked = await loadOrderSnapshot(tx, orderId, { lock: true });
    if (locked === null || locked.order.status !== 'confirmed') return null;
    const { orderEventId } = await recordJournalEvent(tx, {
      orderId,
      type: 'recheck_result',
      actor: SYSTEM_ACTOR,
      payload: {
        ok: false,
        requestEventId: input.requestEventId,
        requestedBy: input.staffId,
        error: 'supplier_unavailable',
        detail: errorText(input.error),
        attempts: (job.attemptsMade ?? 0) + 1,
      },
      at,
    });
    return orderEventId;
  });
  deps.logger.warn(
    { job: 'rossko/recheck', orderId, jobId: job.id, err: errorText(input.error) },
    'recheck: Rossko did not answer, seller card posted',
  );
  if (recheckEventId !== null) {
    await deps.sellerCards.post({
      orderId,
      template: null,
      orderEventId: recheckEventId,
      note: RECHECK_UNAVAILABLE_NOTE,
    });
  }
  return { outcome: 'supplier_unavailable', recheckEventId };
}
