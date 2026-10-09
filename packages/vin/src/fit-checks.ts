/**
 * Step 4 (docs/fit-check.md): «Проверим, подойдёт ли» — the database side of fit checks, shared
 * by the site (the request from the cart, the cart page, the admin) and the worker (the seller
 * bot, expiry, the SLA reminder, retention). The rules themselves are pure functions of
 * @detaly/domain (fit-checks.ts).
 *
 * - createFitCheckRequest: the caller's own cart lines only (the cart row is locked, every id must
 *   be a line of it), a pending row per line (expiring at the closing of the pickup point's next
 *   working day, at least 24 hours later: fitCheckExpiresAt) and ONE outbox notify/fit job for
 *   the sellers card, in one transaction;
 * - answerFitCheck / answerFitAnalog: only a pending row changes (a second answer finds nothing:
 *   «уже отвечено»);
 * - resolveFitAnalog: the master's «БРЕНД АРТИКУЛ», found and priced exactly as a line of a VIN
 *   answer (previewVinAnswer: GetSearch through the caller's search, priceOffer);
 * - expireFitChecks, cancelFitChecks, retainFitChecks: the housekeeping and the cart side.
 *
 * Nothing is logged here: the VIN and the comment never reach a log line (the callers log ids
 * and counts only).
 */
import { NOTIFY_JOBS } from '@detaly/config';
import {
  and,
  asc,
  carts,
  cartItems,
  desc,
  eq,
  fitChecks,
  gt,
  inArray,
  isNotNull,
  or,
  settings,
  sql,
  staff,
  type Database,
  type Executor,
} from '@detaly/db';
import {
  cleanFitComment,
  DEFAULT_FIT_CHECK_SLA_MINUTES,
  fitLineState,
  isFitCheckedState,
  FIT_CHECK_COMMENT_MAX,
  FIT_CHECK_LINES_MAX,
  FIT_CHECK_RETENTION_DAYS,
  FIT_CHECK_SLA_KEY,
  FIT_CHECK_SLA_MAX_MINUTES,
  FIT_CHECK_SLA_MIN_MINUTES,
  fitCheckExpiresAt,
  samePart,
  type EtaSettings,
  type ExcludedRule,
  type FitCheckAnswer,
  type FitCheckFacts,
  type FitCheckStatus,
  type FitPart,
  type IsoDate,
  type Offer,
  type PricingConfig,
  type WeekSchedule,
} from '@detaly/domain';
import { enqueueOutbox } from '@detaly/orders';
import { v7 as uuidv7 } from 'uuid';
import { previewVinAnswer, type VinSearch } from './preview';
import { isUuidString } from './requests';
import { isValidVin } from './vin';

export type FitCheckRow = typeof fitChecks.$inferSelect;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// notify/fit: the sellers card of a request
// ---------------------------------------------------------------------------

/**
 * What a notify/fit job does: `card` posts the card of a new request; `reminder` posts it again
 * with «Без ответа …» once the SLA has passed (closing the older card); `refresh` redraws the open
 * card after an answer from the admin, an expiry or a cancellation.
 */
export const FIT_NOTIFY_KINDS = ['card', 'reminder', 'refresh'] as const;
export type FitNotifyKind = (typeof FIT_NOTIFY_KINDS)[number];

/** notify/fit job data (apps/worker/src/jobs/notify/fit.ts). */
export interface FitNotifyJob {
  requestId: string;
  kind: FitNotifyKind;
  /** The outbox key (logs and diagnostics). */
  key: string;
  /** An extra line of the reminder card without PD («Без ответа больше часа»). */
  note?: string | null;
}

/** Outbox key of the first card of a request. */
export function fitCardKey(requestId: string): string {
  return `fit:${requestId}:card`;
}

/** Outbox key of the one SLA reminder of a request. */
export function fitReminderKey(requestId: string): string {
  return `fit:${requestId}:sla`;
}

/** Outbox key of a redraw; `tag` makes it unique (the answered or cancelled line, `expired`). */
export function fitRefreshKey(requestId: string, tag: string): string {
  return `fit:${requestId}:refresh:${tag}`;
}

/** Queues a notify/fit job (false when the key was queued before). */
export async function enqueueFitNotify(
  tx: Executor,
  job: { requestId: string; kind: FitNotifyKind; key: string; note?: string | null },
): Promise<boolean> {
  const data: FitNotifyJob = {
    requestId: job.requestId,
    kind: job.kind,
    key: job.key,
    ...(job.note ? { note: job.note } : {}),
  };
  return enqueueOutbox(tx, {
    queue: 'notify',
    name: NOTIFY_JOBS.fit,
    key: job.key,
    data: { ...data },
  });
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface CreateFitCheckInput {
  /** The cart of the caller's cookie (carts.id). */
  cartId: string;
  /** Cart lines the client ticked; every one must belong to `cartId`. */
  lineIds: readonly string[];
  /** Normalized VIN (normalizeVin). */
  vin: string;
  comment: string | null;
  now: Date;
  /**
   * Working hours of the pickup point (parseWorkHours(PICKUP_HOURS), as the SLA of the worker):
   * the checks wait until the closing of the next working day; null — 24 hours.
   */
  schedule: WeekSchedule | null;
  /** For tests; a new uuid v7 by default. */
  requestId?: string;
}

/**
 * Why nothing was created:
 * - vin, comment: invalid input (the form checks it first);
 * - no_lines: no line ids, or the cart is not an active cart;
 * - foreign_lines: an id is not a line of this cart (never trust ids from the form);
 * - pending: every ticked line already waits for the master.
 */
export type CreateFitCheckRefusal = 'vin' | 'comment' | 'no_lines' | 'foreign_lines' | 'pending';

export type CreateFitCheckResult =
  | {
      ok: true;
      requestId: string;
      /** Rows created (lines still waiting for an earlier check are skipped). */
      lines: number;
      /** Ticked lines skipped because their check still waits. */
      skipped: number;
    }
  | { ok: false; reason: CreateFitCheckRefusal };

export async function createFitCheckRequest(
  db: Database,
  input: CreateFitCheckInput,
): Promise<CreateFitCheckResult> {
  if (!isValidVin(input.vin)) return { ok: false, reason: 'vin' };
  const comment = cleanFitComment(input.comment);
  if (comment !== null && comment.length > FIT_CHECK_COMMENT_MAX) {
    return { ok: false, reason: 'comment' };
  }
  const ids = [...new Set(input.lineIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return { ok: false, reason: 'no_lines' };
  if (ids.length > FIT_CHECK_LINES_MAX || !ids.every(isUuidString)) {
    return { ok: false, reason: 'foreign_lines' };
  }
  if (!isUuidString(input.cartId)) return { ok: false, reason: 'no_lines' };
  const { now } = input;

  return db.transaction(async (tx): Promise<CreateFitCheckResult> => {
    // The cart row first: the lock order of the cart API and checkout (cart, then its lines).
    const [cart] = await tx
      .select({ id: carts.id, status: carts.status })
      .from(carts)
      .where(eq(carts.id, input.cartId))
      .for('update');
    if (!cart || cart.status !== 'active') return { ok: false, reason: 'no_lines' };
    const lines = await tx
      .select({
        id: cartItems.id,
        brand: cartItems.brand,
        article: cartItems.article,
        name: cartItems.name,
        createdAt: cartItems.createdAt,
      })
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), inArray(cartItems.id, ids)))
      .orderBy(asc(cartItems.createdAt), asc(cartItems.id));
    if (lines.length !== ids.length) return { ok: false, reason: 'foreign_lines' };

    // A line whose check still waits for the master is not sent twice.
    const waiting = await tx
      .select({ cartItemId: fitChecks.cartItemId })
      .from(fitChecks)
      .where(
        and(
          eq(fitChecks.cartId, cart.id),
          inArray(fitChecks.cartItemId, ids),
          eq(fitChecks.status, 'pending'),
          gt(fitChecks.expiresAt, now),
        ),
      );
    const busy = new Set(waiting.map((row) => row.cartItemId));
    const fresh = lines.filter((line) => !busy.has(line.id));
    if (fresh.length === 0) return { ok: false, reason: 'pending' };

    const requestId = input.requestId ?? uuidv7();
    const expiresAt = fitCheckExpiresAt(now, input.schedule);
    await tx.insert(fitChecks).values(
      fresh.map((line) => ({
        id: uuidv7(),
        cartId: cart.id,
        cartItemId: line.id,
        requestId,
        vin: input.vin,
        comment,
        brand: line.brand,
        article: line.article,
        name: line.name,
        status: 'pending' as const,
        createdAt: now,
        expiresAt,
      })),
    );
    await enqueueFitNotify(tx, { requestId, kind: 'card', key: fitCardKey(requestId) });
    return { ok: true, requestId, lines: fresh.length, skipped: lines.length - fresh.length };
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** A stored SLA is used when it is a whole number of minutes within the admin's bounds. */
export function isFitSlaMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= FIT_CHECK_SLA_MIN_MINUTES &&
    value <= FIT_CHECK_SLA_MAX_MINUTES
  );
}

/** settings `fit_check.sla_minutes`; the default (60) when absent or malformed. */
export async function loadFitSlaMinutes(db: Executor): Promise<number> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, FIT_CHECK_SLA_KEY));
  const value = row?.value as unknown;
  return isFitSlaMinutes(value) ? value : DEFAULT_FIT_CHECK_SLA_MINUTES;
}

// ---------------------------------------------------------------------------
// Answers of the master
// ---------------------------------------------------------------------------

export type FitAnswerResult =
  | { ok: true; check: FitCheckRow }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'answered'; status: FitCheckStatus };

/** The analog the master named, found and priced (resolveFitAnalog). */
export interface FitAnalog {
  brand: string;
  article: string;
  name: string;
  /** The supplier offer it was found by: the cart prices it with priceOffer. */
  offer: Offer;
}

async function refusalOf(db: Executor, id: string): Promise<FitAnswerResult> {
  const [row] = await db
    .select({ status: fitChecks.status })
    .from(fitChecks)
    .where(eq(fitChecks.id, id));
  if (!row) return { ok: false, reason: 'not_found' };
  return { ok: false, reason: 'answered', status: row.status as FitCheckStatus };
}

/**
 * «Подходит», «Не подходит», «Нужен звонок»: only a pending row changes, so a second press (or
 * the admin after the bot) changes nothing and gets `answered` with the status it has.
 * `staffId` null: an answer from the admin (Basic auth has no staff member).
 */
export async function answerFitCheck(
  db: Executor,
  input: {
    id: string;
    answer: Exclude<FitCheckAnswer, 'analog'>;
    staffId: string | null;
    now: Date;
  },
): Promise<FitAnswerResult> {
  if (!isUuidString(input.id)) return { ok: false, reason: 'not_found' };
  const [row] = await db
    .update(fitChecks)
    .set({ status: input.answer, answeredAt: input.now, answeredBy: input.staffId })
    .where(and(eq(fitChecks.id, input.id), eq(fitChecks.status, 'pending')))
    .returning();
  return row ? { ok: true, check: row } : refusalOf(db, input.id);
}

/** «Аналог»: the analog the master named, once it was found at the supplier. */
export async function answerFitAnalog(
  db: Executor,
  input: { id: string; analog: FitAnalog; staffId: string | null; now: Date },
): Promise<FitAnswerResult> {
  if (!isUuidString(input.id)) return { ok: false, reason: 'not_found' };
  const [row] = await db
    .update(fitChecks)
    .set({
      status: 'analog',
      analogBrand: input.analog.brand,
      analogArticle: input.analog.article,
      analogName: input.analog.name,
      analogOffer: input.analog.offer,
      answeredAt: input.now,
      answeredBy: input.staffId,
    })
    .where(and(eq(fitChecks.id, input.id), eq(fitChecks.status, 'pending')))
    .returning();
  return row ? { ok: true, check: row } : refusalOf(db, input.id);
}

export interface FitAnalogInput {
  /** The master's reply: «БРЕНД АРТИКУЛ» (the first line that is not a '>' comment). */
  text: string;
  /** The part of the checked line: the same part is not an analog. */
  original: FitPart;
  search: VinSearch;
  pricing: PricingConfig;
  excludedRules: readonly ExcludedRule[];
  eta: EtaSettings;
  now: Date;
  timeZone?: string;
}

export type FitAnalogRefusal =
  'parse' | 'not_found' | 'same' | 'unavailable' | 'excluded' | 'no_stock';

export type FitAnalogResult =
  | {
      ok: true;
      analog: FitAnalog & { priceClientKop: number; etaDate: IsoDate };
    }
  | { ok: false; reason: FitAnalogRefusal; message: string };

/** «не нашёл у поставщика — проверьте артикул» (the founder's wording, lower case as a hint). */
export const FIT_ANALOG_NOT_FOUND = 'Не нашёл у поставщика — проверьте артикул';
export const FIT_ANALOG_FORMAT = 'Нужно «БРЕНД АРТИКУЛ», например «KNECHT OC90»';

/**
 * The analog of the master's reply, checked with GetSearch through `search` (the 15-minute cache
 * and the shared limiter of the caller) and priced with priceOffer: one line of a VIN answer
 * (previewVinAnswer), quantity 1. Never throws for a bad reply or a supplier failure.
 */
export async function resolveFitAnalog(input: FitAnalogInput): Promise<FitAnalogResult> {
  const line = input.text
    .split(/\r?\n/u)
    .map((raw) => raw.trim())
    .find((raw) => raw !== '' && !raw.startsWith('>'));
  if (line === undefined) return { ok: false, reason: 'parse', message: FIT_ANALOG_FORMAT };
  const preview = await previewVinAnswer({
    text: line.replace(/#.*$/u, '').trim(),
    search: input.search,
    pricing: input.pricing,
    excludedRules: input.excludedRules,
    eta: input.eta,
    now: input.now,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  });
  const first = preview.lines[0];
  if (first === undefined) return { ok: false, reason: 'parse', message: FIT_ANALOG_FORMAT };
  if (first.status === 'error') {
    switch (first.reason) {
      case 'not_found':
      case 'brand_mismatch':
        return { ok: false, reason: 'not_found', message: FIT_ANALOG_NOT_FOUND };
      case 'supplier_unavailable':
        return {
          ok: false,
          reason: 'unavailable',
          message: 'Поставщик не ответил — попробуйте ещё раз через минуту',
        };
      case 'excluded':
        return { ok: false, reason: 'excluded', message: first.message };
      case 'no_stock':
        return { ok: false, reason: 'no_stock', message: `Нет у поставщика: ${first.message}` };
      case 'parse':
        return { ok: false, reason: 'parse', message: `${first.message}. ${FIT_ANALOG_FORMAT}` };
    }
  }
  if (samePart(first, input.original)) {
    return {
      ok: false,
      reason: 'same',
      message: 'Это та же деталь, что в корзине — нажмите «Подходит»',
    };
  }
  return {
    ok: true,
    analog: {
      brand: first.brand,
      article: first.article,
      name: first.name,
      offer: first.offer,
      priceClientKop: first.priceClientKop,
      etaDate: first.etaDate,
    },
  };
}

// ---------------------------------------------------------------------------
// Expiry, cancellation, retention
// ---------------------------------------------------------------------------

/** `column <= at` through drizzle's column-aware mapping (null -> false). */
function notAfter(column: Parameters<typeof gt>[0], at: Date) {
  return sql`not (${gt(column, at)})`;
}

/**
 * Pending checks past expires_at become `expired`. Returns the requests that changed (their
 * cards are redrawn).
 */
export async function expireFitChecks(db: Executor, now: Date): Promise<string[]> {
  const rows = await db
    .update(fitChecks)
    .set({ status: 'expired' })
    .where(and(eq(fitChecks.status, 'pending'), notAfter(fitChecks.expiresAt, now)))
    .returning({ requestId: fitChecks.requestId });
  return [...new Set(rows.map((row) => row.requestId))];
}

/**
 * The lines leave the cart (removed, or checked out without an answer): their pending checks
 * become `cancelled` — the master's card says so — and a redraw of each card is queued. Run in
 * the transaction that removes the lines.
 */
export async function cancelFitChecks(
  tx: Executor,
  input: { cartId: string; cartItemIds: readonly string[] },
): Promise<number> {
  if (input.cartItemIds.length === 0) return 0;
  const rows = await tx
    .update(fitChecks)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(fitChecks.cartId, input.cartId),
        inArray(fitChecks.cartItemId, [...input.cartItemIds]),
        eq(fitChecks.status, 'pending'),
      ),
    )
    .returning({ id: fitChecks.id, requestId: fitChecks.requestId });
  for (const row of rows) {
    await enqueueFitNotify(tx, {
      requestId: row.requestId,
      kind: 'refresh',
      key: fitRefreshKey(row.requestId, row.id),
    });
  }
  return rows.length;
}

/**
 * VIN and comment of requests older than FIT_CHECK_RETENTION_DAYS are cleared (as the VIN
 * request photos are deleted). Idempotent; returns how many rows were cleared.
 */
export async function retainFitChecks(db: Executor, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - FIT_CHECK_RETENTION_DAYS * DAY_MS);
  const rows = await db
    .update(fitChecks)
    .set({ vin: null, comment: null })
    .where(
      and(
        notAfter(fitChecks.createdAt, cutoff),
        or(isNotNull(fitChecks.vin), isNotNull(fitChecks.comment)),
      ),
    )
    .returning({ id: fitChecks.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Reads: the cart page, the sellers card
// ---------------------------------------------------------------------------

/** Rows of one cart read for its page (a cart has at most 20 lines and 10 requests a day). */
const CART_ROWS_MAX = 400;

export interface CartFitChecks {
  /** The latest check of every line still in the cart, by cart_items.id. */
  latest: Map<string, FitCheckRow>;
  /** The VIN of the latest request of this cart (pre-fills the form); null after retention. */
  lastVin: string | null;
}

export async function loadCartFitChecks(db: Executor, cartId: string): Promise<CartFitChecks> {
  const latest = new Map<string, FitCheckRow>();
  if (!isUuidString(cartId)) return { latest, lastVin: null };
  const rows = await db
    .select()
    .from(fitChecks)
    .where(eq(fitChecks.cartId, cartId))
    .orderBy(desc(fitChecks.createdAt), desc(fitChecks.id))
    .limit(CART_ROWS_MAX);
  let lastVin: string | null = null;
  for (const row of rows) {
    if (lastVin === null && row.vin !== null) lastVin = row.vin;
    if (row.cartItemId !== null && !latest.has(row.cartItemId)) latest.set(row.cartItemId, row);
  }
  return { latest, lastVin };
}

export interface FitLineStaffView {
  id: string;
  /** 1-based position in the request (the card numbers the lines). */
  n: number;
  brand: string;
  article: string;
  name: string;
  status: FitCheckStatus;
  analog: FitAnalog | null;
  answeredAt: Date | null;
  /** Who answered: a staff member, or null (the admin, or no answer). */
  answeredBy: { id: string; name: string } | null;
}

export interface FitRequestStaffView {
  requestId: string;
  /** The full VIN for the master; null after retention. */
  vin: string | null;
  comment: string | null;
  createdAt: Date;
  expiresAt: Date;
  lines: FitLineStaffView[];
}

/** The request as the sellers card shows it (no client data: there is none but the VIN). */
export async function loadFitRequestForStaff(
  db: Executor,
  requestId: string,
): Promise<FitRequestStaffView | null> {
  if (!isUuidString(requestId)) return null;
  const rows = await db
    .select({ check: fitChecks, staffName: staff.name })
    .from(fitChecks)
    .leftJoin(staff, eq(staff.id, fitChecks.answeredBy))
    .where(eq(fitChecks.requestId, requestId))
    .orderBy(asc(fitChecks.createdAt), asc(fitChecks.id));
  const first = rows[0]?.check;
  if (first === undefined) return null;
  return {
    requestId,
    vin: first.vin,
    comment: first.comment,
    createdAt: first.createdAt,
    expiresAt: first.expiresAt,
    lines: rows.map(({ check, staffName }, index) => ({
      id: check.id,
      n: index + 1,
      brand: check.brand,
      article: check.article,
      name: check.name,
      status: check.status as FitCheckStatus,
      analog:
        check.analogBrand !== null &&
        check.analogArticle !== null &&
        check.analogName !== null &&
        check.analogOffer !== null
          ? {
              brand: check.analogBrand,
              article: check.analogArticle,
              name: check.analogName,
              offer: check.analogOffer,
            }
          : null,
      answeredAt: check.answeredAt,
      answeredBy:
        check.answeredBy !== null && staffName !== null
          ? { id: check.answeredBy, name: staffName }
          : null,
    })),
  };
}

/** The facts fitLineState reads from a row. */
export function fitFactsOf(row: FitCheckRow): FitCheckFacts {
  return {
    status: row.status as FitCheckStatus,
    brand: row.brand,
    article: row.article,
    analogBrand: row.analogBrand,
    analogArticle: row.analogArticle,
    analogKeptAt: row.analogKeptAt,
    expiresAt: row.expiresAt,
  };
}

/** The latest check of each of these lines of a cart (checkout, the checkout page). */
export async function latestFitChecksOfLines(
  db: Executor,
  cartId: string,
  lineIds: readonly string[],
): Promise<Map<string, FitCheckRow>> {
  const latest = new Map<string, FitCheckRow>();
  if (!isUuidString(cartId) || lineIds.length === 0) return latest;
  const rows = await db
    .select()
    .from(fitChecks)
    .where(and(eq(fitChecks.cartId, cartId), inArray(fitChecks.cartItemId, [...lineIds])))
    .orderBy(desc(fitChecks.createdAt), desc(fitChecks.id));
  for (const row of rows) {
    if (row.cartItemId !== null && !latest.has(row.cartItemId)) latest.set(row.cartItemId, row);
  }
  return latest;
}

/** order_items columns of a line ordered after the master's check (none when it was not). */
export interface FitOrderItemColumns {
  fitCheckId?: string;
  fitCheckedAt?: Date;
  fitCheckedBy?: string | null;
  fitGuarantee?: boolean;
}

/**
 * What checkout copies into the order item of a cart line: the check counts only when it says
 * `fits` about this very part, or the line is the analog the master offered (fitLineState,
 * isFitCheckedState); `fit_guarantee` is FIT_GUARANTEE_ENABLED at that moment.
 */
export function fitOrderItemColumns(
  check: FitCheckRow | null | undefined,
  line: FitPart,
  input: { now: Date; guaranteeEnabled: boolean },
): FitOrderItemColumns {
  if (!check || check.answeredAt === null) return {};
  if (!isFitCheckedState(fitLineState(fitFactsOf(check), line, input.now))) return {};
  return {
    fitCheckId: check.id,
    fitCheckedAt: check.answeredAt,
    fitCheckedBy: check.answeredBy,
    fitGuarantee: input.guaranteeEnabled,
  };
}

/** The check and its request, for a press on a line of a card. */
export async function loadFitCheck(db: Executor, id: string): Promise<FitCheckRow | null> {
  if (!isUuidString(id)) return null;
  const [row] = await db.select().from(fitChecks).where(eq(fitChecks.id, id));
  return row ?? null;
}
