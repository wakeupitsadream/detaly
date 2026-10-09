/**
 * The seller side of a VIN request (docs/phase-1c-implementation.md decisions С13, С14, С26):
 * take it, save the checked answer, send the proposal, close it; the read models for the seller
 * bot, the admin and /p/<token>; the checkout hook that marks a request converted.
 *
 * Statuses: new -> in_work (taken or answered) -> offered (proposal sent) -> converted (an order
 * was placed from a proposal cart). closed is set by a seller. A new proposal after «Исправить»
 * replaces the previous one: the old proposal cart becomes `abandoned` and its /p/ link stops
 * selling. Every change locks the request row (`for update`).
 *
 * Nothing here logs: callers log the request id only (and maskVin), never the phone, texts or
 * tokens (decision С28).
 */
import { randomBytes } from 'node:crypto';
import {
  and,
  asc,
  cartItems,
  carts,
  eq,
  inArray,
  isNull,
  orders,
  vinRequests,
  type Database,
  type Executor,
} from '@detaly/db';
import {
  ARTICLE_NORM_RE,
  isKop,
  maskClientText,
  phoneLast4,
  PROPOSAL_TTL_DAYS,
  safeMul,
  sumKop,
  type CartLine,
  type NotificationChannel,
  type VinPreview,
  type VinPreviewLine,
  type VinRequestStatus,
} from '@detaly/domain';
import { v7 as uuidv7 } from 'uuid';
import { isVinPreviewSendable } from './preview';
import { enqueueVinNotify, isUuidString, vinClientKey } from './requests';

/** proposal_token: 24 random bytes in base64url = 32 characters (192 bits). */
export const PROPOSAL_TOKEN_BYTES = 24;
const PROPOSAL_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
/** «Причина закрытия», characters. */
export const VIN_CLOSE_REASON_MAX = 500;
/** The master's answer as typed, characters (20 lines of brand, article, quantity, note). */
export const VIN_ANSWER_TEXT_MAX = 8000;

/** Statuses in which a seller may still work on the request (answer, send, close). */
const WORKABLE: readonly VinRequestStatus[] = ['new', 'in_work', 'offered'];
const NOT_CONVERTED: VinRequestStatus[] = ['new', 'in_work', 'offered', 'closed'];

export interface VinWorkflowDeps {
  db: Database;
  /** Clock (tests); default () => new Date(). */
  now?: () => Date;
  /** Called after a commit that wrote outbox rows (web: PUBLISH OUTBOX_CHANNEL). Never throws. */
  nudge?: () => void;
}

/** Why an action on a request was refused. */
export type VinActionRefusal = 'not_found' | 'closed' | 'converted';

export function newProposalToken(): string {
  return randomBytes(PROPOSAL_TOKEN_BYTES).toString('base64url');
}

export function isProposalToken(value: unknown): value is string {
  return typeof value === 'string' && PROPOSAL_TOKEN_RE.test(value);
}

interface LockedRequest {
  id: string;
  status: VinRequestStatus;
  assignedStaffId: string | null;
  proposalCartId: string | null;
  proposalCount: number;
  preview: VinPreview | null;
}

async function lockRequest(tx: Executor, id: string): Promise<LockedRequest | null> {
  if (!isUuidString(id)) return null;
  const [row] = await tx
    .select({
      id: vinRequests.id,
      status: vinRequests.status,
      assignedStaffId: vinRequests.assignedStaffId,
      proposalCartId: vinRequests.proposalCartId,
      proposalCount: vinRequests.proposalCount,
      preview: vinRequests.preview,
    })
    .from(vinRequests)
    .where(eq(vinRequests.id, id))
    .for('update');
  return row ?? null;
}

function refusalOf(status: VinRequestStatus): VinActionRefusal {
  return status === 'converted' ? 'converted' : 'closed';
}

function staffIdOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isUuidString(value)) throw new TypeError('staffId must be a uuid');
  return value;
}

/** Abandons a previous proposal cart, so its /p/ link only shows (not sells) the old selection. */
async function abandonProposal(tx: Executor, cartId: string | null, at: Date): Promise<void> {
  if (cartId === null) return;
  await tx
    .update(carts)
    .set({ status: 'abandoned', updatedAt: at })
    .where(and(eq(carts.id, cartId), eq(carts.status, 'active')));
}

// ---------------------------------------------------------------------------------------------
// Seller actions
// ---------------------------------------------------------------------------------------------

/**
 * «Взять в работу»: assigns the seller (null for the admin under Basic auth) and moves `new` to
 * `in_work`; an `in_work` or `offered` request only changes hands.
 */
export async function takeVinRequest(
  db: Database,
  input: { id: string; staffId: string | null; now?: Date },
): Promise<{ ok: true; status: VinRequestStatus } | { ok: false; reason: VinActionRefusal }> {
  const staffId = staffIdOf(input.staffId);
  const at = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockRequest(tx, input.id);
    if (!row) return { ok: false, reason: 'not_found' } as const;
    if (!WORKABLE.includes(row.status))
      return { ok: false, reason: refusalOf(row.status) } as const;
    const status: VinRequestStatus = row.status === 'new' ? 'in_work' : row.status;
    await tx
      .update(vinRequests)
      .set({ status, assignedStaffId: staffId ?? row.assignedStaffId, updatedAt: at })
      .where(eq(vinRequests.id, row.id));
    return { ok: true, status } as const;
  });
}

/**
 * Stores the master's answer and its preview (previewVinAnswer). A `new` request becomes
 * `in_work`; an `offered` one stays offered (its proposal is live until a new one is sent).
 */
export async function saveVinPreview(
  db: Database,
  input: {
    id: string;
    answerText: string;
    preview: VinPreview;
    staffId?: string | null;
    now?: Date;
  },
): Promise<{ ok: true } | { ok: false; reason: VinActionRefusal }> {
  const staffId = staffIdOf(input.staffId);
  if (input.answerText.length > VIN_ANSWER_TEXT_MAX) throw new RangeError('answer is too long');
  const at = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockRequest(tx, input.id);
    if (!row) return { ok: false, reason: 'not_found' } as const;
    if (!WORKABLE.includes(row.status))
      return { ok: false, reason: refusalOf(row.status) } as const;
    await tx
      .update(vinRequests)
      .set({
        status: row.status === 'new' ? 'in_work' : row.status,
        assignedStaffId: row.assignedStaffId ?? staffId,
        answerText: input.answerText,
        preview: input.preview,
        updatedAt: at,
      })
      .where(eq(vinRequests.id, row.id));
    return { ok: true } as const;
  });
}

export type SendVinProposalResult =
  | {
      ok: true;
      proposalToken: string;
      cartId: string;
      /** Number of this proposal (vin_requests.proposal_count after the send). */
      n: number;
      expiresAt: Date;
      /**
       * The live proposal already holds exactly this answer (a double click, a repeated bot
       * update): it is returned as is, nothing is written and the client is not messaged again.
       */
      duplicate: boolean;
    }
  | { ok: false; reason: 'not_found' | 'has_errors' | 'empty' | 'closed' };

type OkLine = Extract<VinPreviewLine, { status: 'ok' }>;

/** An `ok` preview line that can become a cart_items row (the database checks it again). */
function isStorableLine(line: VinPreviewLine): line is OkLine {
  return (
    line.status === 'ok' &&
    Number.isSafeInteger(line.qty) &&
    line.qty > 0 &&
    isKop(line.priceClientKop) &&
    line.priceClientKop > 0 &&
    isKop(line.priceSupplierKop) &&
    line.priceSupplierKop > 0 &&
    Number.isSafeInteger(line.markupBp) &&
    line.markupBp >= 0 &&
    ARTICLE_NORM_RE.test(line.searchArticleNorm) &&
    typeof line.offerKey === 'string' &&
    line.offerKey !== ''
  );
}

/**
 * The request's live proposal when it already holds exactly these lines and comment (same
 * offers, quantities and client prices), else null.
 */
async function liveSameProposal(
  tx: Executor,
  row: LockedRequest,
  preview: VinPreview,
  lines: readonly OkLine[],
  at: Date,
): Promise<{ proposalToken: string; cartId: string; expiresAt: Date } | null> {
  if (row.status !== 'offered' || row.proposalCartId === null) return null;
  const [cart] = await tx
    .select({
      id: carts.id,
      status: carts.status,
      token: carts.proposalToken,
      expiresAt: carts.proposalExpiresAt,
      note: carts.sellerNote,
    })
    .from(carts)
    .where(eq(carts.id, row.proposalCartId));
  if (
    !cart ||
    cart.status !== 'active' ||
    cart.token === null ||
    cart.expiresAt === null ||
    at.getTime() >= cart.expiresAt.getTime() ||
    cart.note !== preview.comment
  ) {
    return null;
  }
  const items = await tx
    .select({
      offerKey: cartItems.offerKey,
      qty: cartItems.qty,
      priceClientKop: cartItems.priceClientKop,
    })
    .from(cartItems)
    .where(eq(cartItems.cartId, cart.id));
  const signature = (l: { offerKey: string; qty: number; priceClientKop: number }) =>
    `${l.offerKey}|${l.qty}|${l.priceClientKop}`;
  const stored = items.map(signature).sort();
  const wanted = lines.map(signature).sort();
  if (stored.length !== wanted.length || stored.some((s, i) => s !== wanted[i])) return null;
  return { proposalToken: cart.token, cartId: cart.id, expiresAt: cart.expiresAt };
}

/**
 * «Отправить клиенту»: the saved preview becomes a proposal cart (/p/<token>, PROPOSAL_TTL_DAYS
 * days) and the client gets `vin_proposal` (notify/vin, key `vin:<id>:vin_proposal:<n>`).
 * Refused while the preview has errors (`has_errors`), has no lines or was never saved
 * (`empty`), or the request is closed or converted (`closed`). Sending the same answer again
 * while its proposal is live returns that proposal (`duplicate: true`) without a new message.
 */
export async function sendVinProposal(
  deps: VinWorkflowDeps,
  input: { id: string; staffId: string | null },
): Promise<SendVinProposalResult> {
  const staffId = staffIdOf(input.staffId);
  const at = deps.now?.() ?? new Date();
  const result = await deps.db.transaction(async (tx): Promise<SendVinProposalResult> => {
    const row = await lockRequest(tx, input.id);
    if (!row) return { ok: false, reason: 'not_found' };
    if (!WORKABLE.includes(row.status)) return { ok: false, reason: 'closed' };
    const preview = row.preview;
    if (preview == null || preview.lines.length === 0) return { ok: false, reason: 'empty' };
    if (preview.errorCount > 0 || preview.lines.some((l) => l.status !== 'ok')) {
      return { ok: false, reason: 'has_errors' };
    }
    if (!isVinPreviewSendable(preview)) return { ok: false, reason: 'empty' };
    if (!preview.lines.every(isStorableLine)) return { ok: false, reason: 'has_errors' };
    const lines = preview.lines as OkLine[];
    if (new Set(lines.map((l) => l.offerKey)).size !== lines.length) {
      return { ok: false, reason: 'has_errors' };
    }

    const live = await liveSameProposal(tx, row, preview, lines, at);
    if (live) return { ok: true, ...live, n: row.proposalCount, duplicate: true };

    await abandonProposal(tx, row.proposalCartId, at);

    const token = newProposalToken();
    const expiresAt = new Date(at.getTime() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000);
    const checkedAt = new Date(preview.checkedAt);
    const fetchedAt = Number.isNaN(checkedAt.getTime()) ? at : checkedAt;
    const cartId = uuidv7();
    await tx.insert(carts).values({
      id: cartId,
      status: 'active',
      proposalToken: token,
      proposalExpiresAt: expiresAt,
      sellerNote: preview.comment,
      vinRequestId: row.id,
      createdAt: at,
      updatedAt: at,
    });
    await tx.insert(cartItems).values(
      lines.map((line) => ({
        id: uuidv7(),
        cartId,
        offerKey: line.offerKey,
        searchArticleNorm: line.searchArticleNorm,
        brand: line.offer.brand,
        article: line.offer.article,
        name: line.offer.name,
        qty: line.qty,
        stockId: line.offer.stock.stockId,
        isLocal: line.isLocal,
        etaDate: line.etaDate,
        priceSupplierKop: line.priceSupplierKop,
        priceClientKop: line.priceClientKop,
        markupBp: line.markupBp,
        offerSnapshot: line.offer,
        fetchedAt,
        createdAt: at,
        updatedAt: at,
      })),
    );

    const n = row.proposalCount + 1;
    await tx
      .update(vinRequests)
      .set({
        status: 'offered',
        proposalCartId: cartId,
        answeredAt: at,
        proposalCount: n,
        assignedStaffId: row.assignedStaffId ?? staffId,
        updatedAt: at,
      })
      .where(eq(vinRequests.id, row.id));

    await enqueueVinNotify(tx, {
      vinRequestId: row.id,
      audience: 'client',
      template: 'vin_proposal',
      key: vinClientKey(row.id, 'vin_proposal', n),
      n,
    });
    return { ok: true, proposalToken: token, cartId, n, expiresAt, duplicate: false };
  });
  if (result.ok && !result.duplicate) deps.nudge?.();
  return result;
}

/**
 * «Закрыть заявку» with a reason for the record (no client notification). A live proposal is
 * abandoned. Closing twice is fine; a converted request cannot be closed.
 */
export async function closeVinRequest(
  db: Database,
  input: { id: string; reason: string | null; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'converted' }> {
  const reason = input.reason?.trim() ?? '';
  const at = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockRequest(tx, input.id);
    if (!row) return { ok: false, reason: 'not_found' } as const;
    if (row.status === 'converted') return { ok: false, reason: 'converted' } as const;
    if (row.status === 'closed') return { ok: true } as const;
    await abandonProposal(tx, row.proposalCartId, at);
    await tx
      .update(vinRequests)
      .set({
        status: 'closed',
        closedAt: at,
        closeReason: reason === '' ? null : reason.slice(0, VIN_CLOSE_REASON_MAX),
        updatedAt: at,
      })
      .where(eq(vinRequests.id, row.id));
    return { ok: true } as const;
  });
}

/**
 * Checkout hook (decision С14): an order was created from a cart carrying `vin_request_id`. Runs
 * in the checkout transaction; marks the request `converted` (from any other status: the client
 * bought the master's selection) and links the order when checkout did not. Idempotent.
 */
export async function markVinConverted(
  tx: Executor,
  input: { vinRequestId: string; orderId: string; now?: Date },
): Promise<{ converted: boolean }> {
  if (!isUuidString(input.vinRequestId) || !isUuidString(input.orderId)) {
    return { converted: false };
  }
  const at = input.now ?? new Date();
  await tx
    .update(orders)
    .set({ vinRequestId: input.vinRequestId })
    .where(and(eq(orders.id, input.orderId), isNull(orders.vinRequestId)));
  const rows = await tx
    .update(vinRequests)
    .set({ status: 'converted', updatedAt: at })
    .where(and(eq(vinRequests.id, input.vinRequestId), inArray(vinRequests.status, NOT_CONVERTED)))
    .returning({ id: vinRequests.id });
  return { converted: rows.length > 0 };
}

// ---------------------------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------------------------

export interface VinRequestStaffView {
  id: string;
  status: VinRequestStatus;
  /** Full VIN (a VIN alone is not PD; logs still use maskVin). */
  vin: string | null;
  /** Texts with digit runs, plates and e-mails masked (maskClientText) unless revealPd. */
  carText: string | null;
  needText: string;
  /** '•••4567', or the full E.164 number with revealPd (admin). */
  phone: string;
  channel: NotificationChannel | null;
  /** FileStore keys (photos are never sent to a messenger, decision С2). */
  photos: string[];
  photosDeleted: boolean;
  assignedStaffId: string | null;
  answerText: string | null;
  preview: VinPreview | null;
  proposalCount: number;
  proposalCartId: string | null;
  proposalExpiresAt: Date | null;
  /** Only with revealPd (admin «Открыть подборку»): a bearer secret, never for chats or logs. */
  proposalToken: string | null;
  createdAt: Date;
  answeredAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
}

/**
 * A request for the seller bot (default: phone as '•••4567', digit runs, plates and e-mails of
 * the texts masked) or
 * the admin (`revealPd: true`: full phone and texts, the proposal token). null when not found.
 */
export async function loadVinRequestForStaff(
  db: Executor,
  id: string,
  options: { revealPd?: boolean } = {},
): Promise<VinRequestStaffView | null> {
  if (!isUuidString(id)) return null;
  const [row] = await db
    .select({
      request: vinRequests,
      proposalExpiresAt: carts.proposalExpiresAt,
      proposalToken: carts.proposalToken,
    })
    .from(vinRequests)
    .leftJoin(carts, eq(carts.id, vinRequests.proposalCartId))
    .where(eq(vinRequests.id, id));
  if (!row) return null;
  const r = row.request;
  const reveal = options.revealPd === true;
  const mask = (text: string) => (reveal ? text : maskClientText(text));
  return {
    id: r.id,
    status: r.status,
    vin: r.vin,
    carText: r.carText === null ? null : mask(r.carText),
    needText: mask(r.needText),
    phone: reveal ? r.phone : `•••${phoneLast4(r.phone)}`,
    channel: r.channel,
    photos: [...r.photos],
    photosDeleted: r.photosDeletedAt !== null,
    assignedStaffId: r.assignedStaffId,
    answerText: r.answerText,
    preview: r.preview,
    proposalCount: r.proposalCount,
    proposalCartId: r.proposalCartId,
    proposalExpiresAt: row.proposalExpiresAt ?? null,
    proposalToken: reveal ? (row.proposalToken ?? null) : null,
    createdAt: r.createdAt,
    answeredAt: r.answeredAt,
    closedAt: r.closedAt,
    closeReason: r.closeReason,
  };
}

/** Server-only: lines carry supplier prices and markup, which never reach the browser. */
export interface ProposalView {
  cartId: string;
  vinRequestId: string | null;
  /** The master's comment ('>' lines). */
  comment: string | null;
  /** Proposal lines as cart lines (prices from the answer; /p/ re-prices them from the cache). */
  lines: CartLine[];
  /** Sum of client price x qty of the stored lines. */
  totalKop: number;
  expiresAt: Date;
  /**
   * Cannot be checked out any more: past expires_at, replaced by a newer proposal or the request
   * was closed. Show it read-only with «Попросите мастера обновить подборку».
   */
  expired: boolean;
  /** A newer proposal replaced this one. */
  superseded: boolean;
  /**
   * Step 6 (docs/garage.md): «Купить снова» — the order this proposal repeats (no VIN request,
   * no master's comment: the note lists the parts that did not go in).
   */
  repeat: { orderId: string; orderNumber: string } | null;
}

/** The proposal behind /p/<token>, or null for an unknown or malformed token. */
export async function loadProposal(
  db: Executor,
  token: string,
  now: Date,
): Promise<ProposalView | null> {
  if (!isProposalToken(token)) return null;
  const [row] = await db
    .select({
      cart: carts,
      vinStatus: vinRequests.status,
      currentProposalId: vinRequests.proposalCartId,
      repeatOrderNumber: orders.number,
    })
    .from(carts)
    .leftJoin(vinRequests, eq(vinRequests.id, carts.vinRequestId))
    .leftJoin(orders, eq(orders.id, carts.repeatOrderId))
    .where(eq(carts.proposalToken, token));
  if (!row || row.cart.proposalExpiresAt === null) return null;
  const items = await db
    .select()
    .from(cartItems)
    .where(eq(cartItems.cartId, row.cart.id))
    .orderBy(asc(cartItems.createdAt), asc(cartItems.id));
  const lines: CartLine[] = items.map((item) => ({
    id: item.id,
    offerKey: item.offerKey,
    searchArticleNorm: item.searchArticleNorm,
    qty: item.qty,
    priceSupplierKop: item.priceSupplierKop,
    priceClientKop: item.priceClientKop,
    markupBp: item.markupBp,
    isLocal: item.isLocal,
    etaDate: item.etaDate,
    offer: item.offerSnapshot,
  }));
  const superseded = row.cart.vinRequestId !== null && row.currentProposalId !== row.cart.id;
  const expired =
    superseded ||
    row.cart.status !== 'active' ||
    now.getTime() >= row.cart.proposalExpiresAt.getTime() ||
    row.vinStatus === 'closed';
  return {
    cartId: row.cart.id,
    vinRequestId: row.cart.vinRequestId,
    comment: row.cart.sellerNote,
    lines,
    totalKop: sumKop(lines.map((l) => safeMul(l.priceClientKop, l.qty))),
    expiresAt: row.cart.proposalExpiresAt,
    expired,
    superseded,
    repeat:
      row.cart.repeatOrderId !== null && row.repeatOrderNumber !== null
        ? { orderId: row.cart.repeatOrderId, orderNumber: row.repeatOrderNumber }
        : null,
  };
}
