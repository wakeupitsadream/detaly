/**
 * Phase 1C blocks of /o/<token> (docs/phase-1c-implementation.md section 10): status
 * notifications in Telegram, the installation booking, claims and the packaging photos. A read
 * model next to OrderView (order-view.ts), loaded after it with the same order id; the
 * presentational components get everything as final texts.
 *
 * Personal data: the client's phone is never loaded; the claim texts of this order are (the
 * client wrote their own text and reads the answer here, decision С2 keeps them out of the
 * messengers). Photo keys never reach the page: photos are served by id through
 * /api/orders/<token>/photos/<id>, and only packaging and handover ones.
 */
import { randomUUID } from 'node:crypto';
import type { Env } from '@detaly/config';
import { eq, orders, type Executor } from '@detaly/db';
import {
  CLAIM_DECISION_LABELS,
  CLAIM_KIND_HINTS,
  CLAIM_KIND_LABELS,
  CLAIM_PHOTOS_MAX,
  CLAIM_TEXT_MAX,
  claimKindsAvailable,
  formatDayMonth,
  INSTALL_BOOKABLE_STATUSES,
  isIsoDate,
  localDate,
  type ClaimDecision,
  type ClaimKind,
  type InstallSlot,
  type OrderStatus,
} from '@detaly/domain';
import {
  isLiveState,
  loadBookingsView,
  loadClaimsView,
  loadOrderPhotos,
  messengerStatus,
  type BookingView,
  type ClaimView,
  type InstallSlotsReason,
  type MessengerStatus,
} from '@detaly/orders';
import { slotsForOrder } from '../install/order-slots';
import { formatEventTime } from './timeline';
import type { OrderView } from './order-view';

/** The static return memo (scripts/make-print-pdfs.ts, decision С23). */
export const RETURN_MEMO_PDF = '/print/pamyatka-vozvrat.pdf';

const AFTER_HANDOVER: ReadonlySet<OrderStatus> = new Set(['handed', 'completed']);
const BOOKABLE: ReadonlySet<OrderStatus> = new Set(INSTALL_BOOKABLE_STATUSES);
/** Orders with nothing left to notify about: the block is not shown. */
const NO_MESSENGER: ReadonlySet<OrderStatus> = new Set(['cancelled', 'refunded']);

/** Telegram usernames: 5–32 characters, a letter first (BotFather rules). */
const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/** TG_CLIENT_BOT_USERNAME without '@', or null when unset or not a username. */
export function clientBotUsername(env: Pick<Env, 'TG_CLIENT_BOT_USERNAME'>): string | null {
  const raw = env.TG_CLIENT_BOT_USERNAME?.trim().replace(/^@/, '') ?? '';
  return BOT_USERNAME_RE.test(raw) ? raw : null;
}

/** The installation partner from env; null hides the booking (decision С6). */
export function installPartner(
  env: Pick<Env, 'INSTALL_PARTNER_NAME' | 'INSTALL_PARTNER_REQUISITES'>,
): { name: string; requisites: string | null } | null {
  const name = env.INSTALL_PARTNER_NAME?.trim();
  if (!name) return null;
  return { name, requisites: env.INSTALL_PARTNER_REQUISITES?.trim() || null };
}

export interface MessengerView {
  telegram: MessengerStatus['telegram'];
  /** TG_CLIENT_BOT_USERNAME is set: «Статусы в Telegram» is a working button. */
  telegramAvailable: boolean;
}

export interface BookingCardView {
  id: string;
  status: 'requested' | 'confirmed';
  slot: InstallSlot;
  /** The client may still cancel without calling (until slot − 2 h). */
  canCancel: boolean;
  /** '9 октября, 12:00': the last moment to cancel here. */
  cancelUntilText: string;
}

export interface InstallBlockView {
  partner: { name: string; requisites: string | null };
  booking: BookingCardView | null;
  slots: InstallSlot[];
  /** Why there are no slots (null when there are, or when a booking is shown). */
  emptyReason: InstallSlotsReason | null;
  /** Idempotency key of this rendering of the form (bookInstall request_key). */
  requestKey: string;
  /** The sample order: the slots come from the simulated load. */
  demo: boolean;
}

export interface ClaimKindOption {
  kind: ClaimKind;
  label: string;
  hint: string;
}

export interface ClaimTarget {
  /** '' for the whole order, otherwise order_items.id. */
  value: string;
  label: string;
}

export interface ClaimFormView {
  kinds: ClaimKindOption[];
  targets: ClaimTarget[];
  requestKey: string;
  /** 0 when photo storage is off (the field is hidden). */
  maxPhotos: number;
  maxFileMb: number;
  textMax: number;
}

export interface ClaimCardView {
  id: string;
  kind: ClaimKind;
  kindLabel: string;
  /** 'Knecht OC 90' or 'Весь заказ'. */
  targetLabel: string;
  openedText: string;
  /** '12 октября' (+10 days from the claim, art. 22 ЗоЗПП). */
  deadlineText: string;
  open: boolean;
  returnAcceptedText: string | null;
  decision: ClaimDecision | null;
  decisionLabel: string | null;
  decisionText: string | null;
  clientText: string | null;
  photoCount: number;
  /** A refund decision: the money state is the RefundBlock below. */
  refund: boolean;
}

export interface ClaimsBlockView {
  form: ClaimFormView | null;
  claims: ClaimCardView[];
  /** Link to the static memo after the handover. */
  memoUrl: string | null;
  /** The sample order: the form shows how it works and posts to the demo screen. */
  demo: boolean;
}

export interface OrderPhotoItem {
  id: string;
  kind: 'packaging' | 'handover';
  /** /api/orders/<token>/photos/<id>; null for the demo placeholder (no file at all). */
  url: string | null;
}

export interface OrderServicesView {
  messenger: MessengerView | null;
  install: InstallBlockView | null;
  claims: ClaimsBlockView | null;
  photos: OrderPhotoItem[];
  demo: boolean;
}

export const EMPTY_SERVICES: OrderServicesView = {
  messenger: null,
  install: null,
  claims: null,
  photos: [],
  demo: false,
};

/** '12 октября' in the client zone. */
export function dayText(at: Date): string {
  return formatDayMonth(localDate(at));
}

export function bookingCard(booking: BookingView, now: Date): BookingCardView | null {
  if (!booking.active) return null;
  return {
    id: booking.id,
    status: booking.status === 'confirmed' ? 'confirmed' : 'requested',
    slot: booking.slot,
    canCancel: now.getTime() <= booking.clientCancelUntil.getTime(),
    cancelUntilText: formatEventTime(booking.clientCancelUntil),
  };
}

export function claimCard(claim: ClaimView): ClaimCardView {
  return {
    id: claim.id,
    kind: claim.kind,
    kindLabel: CLAIM_KIND_LABELS[claim.kind],
    targetLabel: claim.item ? `${claim.item.brand} ${claim.item.article}` : 'Весь заказ',
    openedText: formatEventTime(claim.openedAt),
    deadlineText: dayText(claim.deadlineAt),
    open: claim.open,
    returnAcceptedText:
      claim.returnAcceptedAt === null ? null : formatEventTime(claim.returnAcceptedAt),
    decision: claim.decision,
    decisionLabel: claim.decision === null ? null : CLAIM_DECISION_LABELS[claim.decision],
    decisionText: claim.decisionText,
    clientText: claim.clientText,
    photoCount: claim.photoCount,
    refund: claim.decision === 'refund',
  };
}

export function kindOptions(kinds: readonly ClaimKind[]): ClaimKindOption[] {
  return kinds.map((kind) => ({
    kind,
    label: CLAIM_KIND_LABELS[kind],
    hint: CLAIM_KIND_HINTS[kind],
  }));
}

export interface LoadOrderServicesOptions {
  env: Env;
  now?: Date;
  /** Photo uploads accepted (server/files.ts photosEnabled()). */
  photosEnabled: boolean;
  /** FILES_MAX_UPLOAD_MB */
  maxFileMb: number;
}

/** The 1C blocks of a loaded order view. */
export async function loadOrderServices(
  db: Executor,
  view: OrderView,
  options: LoadOrderServicesOptions,
): Promise<OrderServicesView> {
  const now = options.now ?? new Date();
  const { env } = options;
  const [row] = await db
    .select({ userId: orders.userId, handedAt: orders.handedAt })
    .from(orders)
    .where(eq(orders.id, view.id));
  if (!row) return EMPTY_SERVICES;

  const partner = installPartner(env);
  const bookable = partner !== null && view.fulfillment === 'pickup' && BOOKABLE.has(view.status);
  const afterHandover = AFTER_HANDOVER.has(view.status);
  const kinds = claimKindsAvailable({
    status: view.status,
    scheme: view.scheme,
    moneyHeld: view.moneyHeld,
    handedAt: row.handedAt,
    promisedDate: isIsoDate(view.promisedDate) ? view.promisedDate : null,
    now,
  });

  const [messenger, bookings, claims, photos] = await Promise.all([
    NO_MESSENGER.has(view.status) ? Promise.resolve(null) : messengerStatus(db, row.userId),
    bookable ? loadBookingsView(db, view.id) : Promise.resolve([]),
    loadClaimsView(db, view.id, { texts: true }),
    loadOrderPhotos(db, view.id, ['packaging', 'handover']),
  ]);

  let install: InstallBlockView | null = null;
  if (bookable && partner !== null) {
    const active = bookings.find((booking) => booking.active) ?? null;
    const booking = active === null ? null : bookingCard(active, now);
    const slots =
      booking === null
        ? await slotsForOrder(db, { orderId: view.id, now, hours: env.PICKUP_HOURS ?? null })
        : { slots: [], reason: null };
    install = {
      partner,
      booking,
      slots: slots.slots,
      emptyReason: slots.reason,
      requestKey: randomUUID(),
      demo: false,
    };
  }

  const cards = claims.map(claimCard);
  let form: ClaimFormView | null = null;
  const wholeOpen = claims.some((claim) => claim.open && claim.orderItemId === null);
  if (kinds.length > 0 && !wholeOpen) {
    const openItems = new Set(
      claims.filter((c) => c.open && c.orderItemId !== null).map((c) => c.orderItemId),
    );
    const items = view.items.filter((item) =>
      afterHandover ? item.state === 'handed' : isLiveState(item.state),
    );
    // Before the handover the only claim is a delay, and a delay is the refusal of the whole
    // order (decision С10): no item targets.
    const targets: ClaimTarget[] = [
      { value: '', label: 'Весь заказ' },
      ...(afterHandover ? items : [])
        .filter((item) => !openItems.has(item.id))
        .map((item) => ({ value: item.id, label: `${item.brand} ${item.article} — ${item.name}` })),
    ];
    form = {
      kinds: kindOptions(kinds),
      targets,
      requestKey: randomUUID(),
      maxPhotos: options.photosEnabled ? CLAIM_PHOTOS_MAX : 0,
      maxFileMb: options.maxFileMb,
      textMax: CLAIM_TEXT_MAX,
    };
  }
  const claimsBlock: ClaimsBlockView | null =
    form === null && cards.length === 0 && !afterHandover
      ? null
      : { form, claims: cards, memoUrl: afterHandover ? RETURN_MEMO_PDF : null, demo: false };

  return {
    messenger:
      messenger === null
        ? null
        : { telegram: messenger.telegram, telegramAvailable: clientBotUsername(env) !== null },
    install,
    claims: claimsBlock,
    photos: photos.map((photo) => ({
      id: photo.id,
      kind: photo.kind === 'handover' ? 'handover' : 'packaging',
      url: `/api/orders/${view.token}/photos/${photo.id}`,
    })),
    demo: false,
  };
}
